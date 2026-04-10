// services/aiSupportService.js

const Groq = require('groq-sdk');
const { db, sql } = require('../config/db');
const ticketService = require('./ticketService');
const notifyUser    = require('../utils/notifyUser');
const logger        = require('../utils/logger');

const client = new Groq(); // reads GROQ_API_KEY from env

// ── Tool definitions (OpenAI format — Groq compatible) ────────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name:        'resolve_issue',
      description: 'Call this when the user confirms their problem is fully resolved. Only call when the user is satisfied.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'One-sentence summary of what was resolved.' },
        },
        required: ['summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'create_ticket',
      description: 'Call this when the issue cannot be resolved in chat and needs a human support agent.',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['Billing', 'Technical Issue', 'Connection Issue', 'Slow Speed', 'New Connection', 'Plan Change', 'KYC', 'Other'],
          },
          subject:     { type: 'string' },
          description: { type: 'string' },
          priority:    { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['category', 'subject', 'description', 'priority'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'dispatch_technician',
      description: 'Call this ONLY when a physical visit is needed: no internet at all, hardware failure, cable damage, or new installation.',
      parameters: {
        type: 'object',
        properties: {
          subject:     { type: 'string' },
          description: { type: 'string' },
          reason:      { type: 'string', description: 'Why a field visit is needed.' },
        },
        required: ['subject', 'description', 'reason'],
      },
    },
  },
];

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Speedo, a friendly and efficient AI support assistant for Speedonet — a broadband internet service provider. Your job is to help customers solve their problems through conversation, and only escalate to a human or technician when truly necessary.

## Your personality
- Warm, concise, and professional. Never robotic.
- Ask one focused question at a time.
- Acknowledge frustration briefly, then move to solving.

## Troubleshooting knowledge
You know how to guide users through:
- Modem/router power cycle (unplug 30 sec, replug)
- Checking all cable connections (coax, ethernet, power)
- Checking the ONT/fiber box indicator lights
- Restarting the device's network adapter
- Checking if the issue affects all devices or just one
- Checking for scheduled maintenance
- Checking plan status / payment due

## Decision rules (important — follow strictly)
1. Always try at least 2–3 troubleshooting steps before escalating.
2. After troubleshooting, ask: "Did that fix it?"
3. **resolve_issue** — only when the user explicitly confirms it's working.
4. **create_ticket** — billing, account, KYC, plan changes, or tech issues that survive remote troubleshooting.
5. **dispatch_technician** — zero connectivity after full remote steps, hardware failure, physical cable damage, new installation.
6. Never create a ticket or dispatch unless you have enough information (category, nature of problem, steps tried).
7. Keep conversations short — aim to resolve or escalate within 4–6 turns.`;

// ── Core function: process one user message ───────────────────────────────────

async function processMessage(userId, sessionId, userMessage) {
  // 1. Load session
  const session = await _getSession(sessionId, userId);
  if (!session) throw Object.assign(new Error('Session not found.'), { statusCode: 404 });
  if (session.status !== 'active') {
    throw Object.assign(
      new Error('This support session is already closed.'),
      { statusCode: 400 }
    );
  }

  // 2. Persist user message
  await _saveMessage(sessionId, 'user', userMessage);

  // 3. Load full history
  const history = await _loadHistory(sessionId);

  // 4. Call Groq
  const response = await client.chat.completions.create({
    model:       'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
    ],
    tools:       TOOLS,
    tool_choice: 'auto',
    max_tokens:  1024,
  });

  // 5. Parse response (Groq uses OpenAI format)
  const choice        = response.choices[0];
  const message       = choice.message;
  const assistantText = message.content ?? '';
  const toolCall      = message.tool_calls?.[0];

  // 6. Persist assistant reply
  if (assistantText) {
    await _saveMessage(sessionId, 'assistant', assistantText);
  }

  // 7. Handle tool call
  if (toolCall) {
    const toolBlock = {
      name:  toolCall.function.name,
      input: JSON.parse(toolCall.function.arguments),
    };
    return await _handleToolCall(userId, sessionId, toolBlock, assistantText);
  }

  return { reply: assistantText, action: null, ticketId: null, sessionStatus: 'active' };
}  // ← was missing in the previous version

// ── Tool handler ──────────────────────────────────────────────────────────────

async function _handleToolCall(userId, sessionId, toolBlock, precedingText) {
  const { name, input } = toolBlock;
  logger.info(`[AI Support] Tool: ${name} for session ${sessionId}`);

  switch (name) {
    case 'resolve_issue': {
      await _closeSession(sessionId, 'resolved');
      const reply = precedingText ||
        `Great, I'm glad that resolved it! Your session is now closed. If anything else comes up, feel free to start a new conversation.`;
      return { reply, action: 'resolved', ticketId: null, sessionStatus: 'resolved' };
    }

    case 'create_ticket': {
      const { category, subject, description, priority } = input;
      const fullDescription = description;

      const result = await ticketService.createTicket(userId, {
        category,
        subject,
        description: fullDescription,
        priority,
      });

      await db.updateTable('dbo.ai_support_sessions')
        .set({
          status:     'escalated',
          outcome:    'ticket',
          ticket_id:  BigInt(result.id),
          updated_at: sql`SYSUTCDATETIME()`,
        })
        .where('id', '=', BigInt(sessionId))
        .execute();

      const reply = precedingText ||
        `I've created support ticket **${result.ticket_number}** for you. A member of our team will follow up shortly. You can track and chat about this ticket from the Help section of the app.`;

      return {
        reply,
        action:        'ticket_created',
        ticketId:      Number(result.id),
        ticketNumber:  result.ticket_number,
        sessionStatus: 'escalated',
      };
    }

    case 'dispatch_technician': {
      const { subject, description, reason } = input;
      const fullDescription =
  `${description}\n\nReason physical visit required: ${reason}`;

      const result = await ticketService.createTicket(userId, {
        category:    'Technical Issue',
        subject,
        description: fullDescription,
        priority:    'high',
      });

      await db.updateTable('dbo.help_tickets')
        .set({
          requires_technician: true,
          tech_job_status:     'open',
          job_opened_at:       new Date(),
          updated_at:          sql`SYSUTCDATETIME()`,
        })
        .where('id', '=', BigInt(result.id))
        .execute();

      await db.updateTable('dbo.ai_support_sessions')
        .set({
          status:     'escalated',
          outcome:    'technician',
          ticket_id:  BigInt(result.id),
          updated_at: sql`SYSUTCDATETIME()`,
        })
        .where('id', '=', BigInt(sessionId))
        .execute();

      await notifyUser(db, userId, {
        type:  'support_ticket',
        title: 'Technician Request Raised 🔧',
        body:  `We're sending a technician for ticket ${result.ticket_number}. You can track their location once assigned.`,
        data:  { ticket_number: result.ticket_number },
      });

      const reply = precedingText ||
        `I've raised a technician visit request (ticket **${result.ticket_number}**). Our team will assign a field technician shortly — you'll be able to track their location in real time from the app.`;

      return {
        reply,
        action:        'technician_dispatched',
        ticketId:      Number(result.id),
        ticketNumber:  result.ticket_number,
        sessionStatus: 'escalated',
      };
    }

    default:
      return { reply: precedingText, action: null, ticketId: null, sessionStatus: 'active' };
  }
}

// ── Session management ────────────────────────────────────────────────────────

async function startSession(userId) {
  const row = await db
    .insertInto('dbo.ai_support_sessions')
    .values({ user_id: BigInt(userId) })
    .output(['inserted.id', 'inserted.status', 'inserted.created_at'])
    .executeTakeFirstOrThrow();

  const greeting = `Hi! I'm Speedo, your Speedonet support assistant. What can I help you with today?`;
  await _saveMessage(Number(row.id), 'assistant', greeting);

  return {
    sessionId:     Number(row.id),
    greeting,
    sessionStatus: 'active',
  };
}

async function getSession(userId, sessionId) {
  const session = await _getSession(sessionId, userId);
  if (!session) return null;
  const messages = await _loadHistory(sessionId);
  return { session, messages };
}

async function getUserSessions(userId, limit = 10) {
  const sessions = await db
    .selectFrom('dbo.ai_support_sessions')
    .select(['id', 'status', 'outcome', 'ticket_id', 'created_at'])
    .where('user_id', '=', BigInt(userId))
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();
  return sessions;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function _getSession(sessionId, userId) {
  return db
    .selectFrom('dbo.ai_support_sessions')
    .select(['id', 'status', 'outcome', 'ticket_id'])
    .where('id',      '=', BigInt(sessionId))
    .where('user_id', '=', BigInt(userId))
    .executeTakeFirst();
}

async function _saveMessage(sessionId, role, content) {
  await db.insertInto('dbo.ai_support_messages').values({
    session_id: BigInt(sessionId),
    role,
    content,
  }).execute();
}

async function _loadHistory(sessionId) {
  const rows = await db
    .selectFrom('dbo.ai_support_messages')
    .select(['role', 'content'])
    .where('session_id', '=', BigInt(sessionId))
    .orderBy('created_at', 'asc')
    .execute();

  return rows.map(r => ({ role: r.role, content: r.content }));
}

async function _closeSession(sessionId, outcome) {
  await db.updateTable('dbo.ai_support_sessions')
    .set({ status: 'resolved', outcome, updated_at: sql`SYSUTCDATETIME()` })
    .where('id', '=', BigInt(sessionId))
    .execute();
}

module.exports = { startSession, processMessage, getSession, getUserSessions };