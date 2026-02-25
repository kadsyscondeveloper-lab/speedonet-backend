/**
 * types/database.ts
 *
 * Kysely table interface definitions — mirror your T-SQL schema exactly.
 * Column names match what SQL Server returns. Types match T-SQL types.
 *
 * Naming convention:
 *   - Table interfaces use PascalCase: UsersTable
 *   - The Database interface maps snake_case table names to their interfaces
 *   - Use `Generated<T>` for IDENTITY / default columns
 *   - Use `ColumnType<S, I, U>` when select/insert/update types differ
 */

import { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

// ── Shared helpers ────────────────────────────────────────────────────────────

/** SQL Server IDENTITY column — auto on insert, never on update */
type AutoId = Generated<bigint>;

/** SYSUTCDATETIME() default — auto on insert */
type AutoDate = ColumnType<Date, Date | undefined, Date | undefined>;

// =============================================================================
// dbo.users
// =============================================================================
export interface UsersTable {
  id:              AutoId;
  name:            string;
  phone:           string;
  email:           string | null;
  password_hash:   string | null;
  profile_image:   string | null;
  wallet_balance:  ColumnType<string, string | undefined, string>; // DECIMAL stored as string by mssql
  is_active:       ColumnType<boolean, boolean | undefined, boolean>;
  created_at:      AutoDate;
  updated_at:      AutoDate;
}

export type User         = Selectable<UsersTable>;
export type NewUser      = Insertable<UsersTable>;
export type UserUpdate   = Updateable<UsersTable>;

// =============================================================================
// dbo.otp_requests
// =============================================================================
export interface OtpRequestsTable {
  id:         AutoId;
  phone:      string;
  otp_code:   string;
  purpose:    string;         // 'login' | 'forgot_password'
  is_used:    ColumnType<boolean, boolean | undefined, boolean>;
  expires_at: Date;
  created_at: AutoDate;
}

export type OtpRequest    = Selectable<OtpRequestsTable>;
export type NewOtpRequest = Insertable<OtpRequestsTable>;

// =============================================================================
// dbo.user_sessions
// =============================================================================
export interface UserSessionsTable {
  id:          AutoId;
  user_id:     bigint;
  token:       string;
  device_info: string | null;
  ip_address:  string | null;
  expires_at:  Date;
  created_at:  AutoDate;
}

export type UserSession    = Selectable<UserSessionsTable>;
export type NewUserSession = Insertable<UserSessionsTable>;

// =============================================================================
// dbo.referral_codes
// =============================================================================
export interface ReferralCodesTable {
  id:           AutoId;
  user_id:      bigint;
  code:         string;
  referral_url: string | null;
  created_at:   AutoDate;
}

export type ReferralCode    = Selectable<ReferralCodesTable>;
export type NewReferralCode = Insertable<ReferralCodesTable>;

// =============================================================================
// dbo.referrals
// =============================================================================
export interface ReferralsTable {
  id:              AutoId;
  referrer_id:     bigint;
  referred_id:     bigint;
  referral_code:   string;
  status:          ColumnType<string, string | undefined, string>; // 'pending' | 'rewarded'
  referrer_reward: ColumnType<string | null, string | null | undefined, string | null>;
  created_at:      AutoDate;
}

export type Referral    = Selectable<ReferralsTable>;
export type NewReferral = Insertable<ReferralsTable>;

// =============================================================================
// dbo.broadband_plans
// =============================================================================
export interface BroadbandPlansTable {
  id:            Generated<number>;
  name:          string;
  price:         string;          // DECIMAL
  speed_mbps:    number;
  data_limit:    string | null;
  validity_days: number;
  category:      string | null;
  is_active:     ColumnType<boolean, boolean | undefined, boolean>;
  sort_order:    ColumnType<number, number | undefined, number>;
  created_at:    AutoDate;
  updated_at:    AutoDate;
}

export type BroadbandPlan    = Selectable<BroadbandPlansTable>;
export type NewBroadbandPlan = Insertable<BroadbandPlansTable>;

// =============================================================================
// dbo.payment_orders
// =============================================================================
export interface PaymentOrdersTable {
  id:               AutoId;
  user_id:          bigint;
  order_ref:        string;
  type:             string;         // 'broadband_plan' | 'wallet_recharge'
  plan_id:          number | null;
  provider_id:      bigint | null;
  base_amount:      string;         // DECIMAL
  gst_amount:       string;
  discount_amount:  string;
  total_amount:     string;
  payment_method:   string;
  payment_status:   string;         // 'pending' | 'success' | 'failed'
  gateway_name:     string | null;
  gateway_order_id: string | null;
  gateway_txn_id:   string | null;
  paid_at:          Date | null;
  created_at:       AutoDate;
  updated_at:       AutoDate;
}

export type PaymentOrder    = Selectable<PaymentOrdersTable>;
export type NewPaymentOrder = Insertable<PaymentOrdersTable>;

// =============================================================================
// dbo.user_subscriptions
// =============================================================================
export interface UserSubscriptionsTable {
  id:           AutoId;
  user_id:      bigint;
  plan_id:      number;
  order_id:     bigint;
  status:       ColumnType<string, string | undefined, string>; // 'active' | 'expired' | 'cancelled'
  start_date:   Date;
  expires_at:   Date;
  data_used_gb: ColumnType<string, string | undefined, string>;
  created_at:   AutoDate;
  updated_at:   AutoDate;
}

export type UserSubscription    = Selectable<UserSubscriptionsTable>;
export type NewUserSubscription = Insertable<UserSubscriptionsTable>;

// =============================================================================
// dbo.wallet_transactions
// =============================================================================
export interface WalletTransactionsTable {
  id:             AutoId;
  user_id:        bigint;
  type:           string;        // 'credit' | 'debit'
  amount:         string;        // DECIMAL
  balance_after:  string;
  description:    string | null;
  reference_id:   string | null;
  reference_type: string | null; // 'payment_order' | 'wallet_recharge' | 'referral'
  created_at:     AutoDate;
}

export type WalletTransaction    = Selectable<WalletTransactionsTable>;
export type NewWalletTransaction = Insertable<WalletTransactionsTable>;

// =============================================================================
// dbo.user_addresses
// =============================================================================
export interface UserAddressesTable {
  id:         AutoId;
  user_id:    bigint;
  label:      ColumnType<string, string | undefined, string>;
  house_no:   string | null;
  address:    string | null;
  city:       string | null;
  state:      string | null;
  pin_code:   string | null;
  is_primary: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: AutoDate;
  updated_at: AutoDate;
}

export type UserAddress    = Selectable<UserAddressesTable>;
export type NewUserAddress = Insertable<UserAddressesTable>;

// =============================================================================
// dbo.kyc_submissions
// =============================================================================
export interface KycSubmissionsTable {
  id:                  AutoId;
  user_id:             bigint;
  address_proof_type:  string;
  address_proof_data:  string;   // base64 — NVarChar(MAX)
  address_proof_mime:  string;
  id_proof_type:       string;
  id_proof_data:       string;
  id_proof_mime:       string;
  status:              ColumnType<string, string | undefined, string>; // 'pending' | 'approved' | 'rejected' | 'under_review'
  rejection_reason:    string | null;
  submitted_at:        AutoDate;
  reviewed_at:         Date | null;
  updated_at:          AutoDate;
}

export type KycSubmission    = Selectable<KycSubmissionsTable>;
export type NewKycSubmission = Insertable<KycSubmissionsTable>;

// =============================================================================
// dbo.notifications
// =============================================================================
export interface NotificationsTable {
  id:         AutoId;
  user_id:    bigint;
  type:       string;
  title:      string;
  body:       string;
  is_read:    ColumnType<boolean, boolean | undefined, boolean>;
  deep_link:  string | null;
  created_at: AutoDate;
}

export type Notification    = Selectable<NotificationsTable>;
export type NewNotification = Insertable<NotificationsTable>;


// =============================================================================
// dbo.help_tickets
// =============================================================================
export interface HelpTicketsTable {
  id:             AutoId;
  user_id:        bigint;
  ticket_number:  string;                              // e.g. SPT-20240223-AB12CD
  category:       string;                              // nvarchar(30)
  subject:        string;                              // nvarchar(300)
  description:    string;                              // nvarchar(MAX)
  attachment_url: string | null;                       // nvarchar(500)
  status:         ColumnType<string, string | undefined, string>; // 'open' | 'in_progress' | 'resolved' | 'closed'
  priority:       ColumnType<string, string | undefined, string>; // 'low' | 'medium' | 'high'
  assigned_to:    bigint | null;
  resolved_at:    Date | null;
  created_at:     AutoDate;
  updated_at:     AutoDate;
}

export type HelpTicket    = Selectable<HelpTicketsTable>;
export type NewHelpTicket = Insertable<HelpTicketsTable>;

// =============================================================================
// dbo.ticket_replies
// =============================================================================
export interface TicketRepliesTable {
  id:             AutoId;
  ticket_id:      bigint;
  sender_id:      bigint;
  sender_type:    string;    // 'user' | 'admin'  — nvarchar(10)
  message:        string;    // nvarchar(MAX)
  attachment_url: string | null;
  created_at:     AutoDate;
}

export type TicketReply    = Selectable<TicketRepliesTable>;
export type NewTicketReply = Insertable<TicketRepliesTable>;

// =============================================================================
// dbo.carousel_banners
// =============================================================================

export interface CarouselBannersTable {
  id: AutoId;
  title: string | null;
  subtitle: string | null;
  image_data: string;           // Base64 string
  image_mime: string;           // e.g., 'image/jpeg', 'image/png'
  description: string | null;
  order: ColumnType<number, number | undefined, number>;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: AutoDate;
  updated_at: AutoDate;
}

export type CarouselBanner = Selectable<CarouselBannersTable>;


// =============================================================================
// dbo.bills
// =============================================================================
export interface BillsTable {
  id:                    AutoId;
  user_id:               bigint;
  plan_id:               number | null;
  bill_number:           string;
  billing_period_start:  Date;
  billing_period_end:    Date;
  base_amount:           string;
  gst_amount:            string;
  total_amount:          string;
  due_date:              Date;
  status:                ColumnType<string, string | undefined, string>; // 'paid' | 'unpaid' | 'overdue'
  paid_via_order:        bigint | null;
  paid_at:               Date | null;
  created_at:            AutoDate;
}

export type Bill       = Selectable<BillsTable>;
export type NewBill    = Insertable<BillsTable>;
export type BillUpdate = Updateable<BillsTable>;

// =============================================================================
// Root Database interface — passed to Kysely<Database>
// =============================================================================
export interface Database {
  'dbo.users':                UsersTable;
  'dbo.otp_requests':         OtpRequestsTable;
  'dbo.user_sessions':        UserSessionsTable;
  'dbo.referral_codes':       ReferralCodesTable;
  'dbo.referrals':            ReferralsTable;
  'dbo.broadband_plans':      BroadbandPlansTable;
  'dbo.payment_orders':       PaymentOrdersTable;
  'dbo.user_subscriptions':   UserSubscriptionsTable;
  'dbo.wallet_transactions':  WalletTransactionsTable;
  'dbo.user_addresses':       UserAddressesTable;
  'dbo.kyc_submissions':      KycSubmissionsTable;
  'dbo.notifications':        NotificationsTable;
  'dbo.help_tickets':   HelpTicketsTable;
  'dbo.ticket_replies': TicketRepliesTable;
  'dbo.carousel_banners': CarouselBannersTable;
  'dbo.bills': BillsTable;
}