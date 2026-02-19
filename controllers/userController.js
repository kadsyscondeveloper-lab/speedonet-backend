const userService = require('../services/userService');
const R           = require('../utils/response');

// =============================================================================
// GET /api/v1/user/profile
// =============================================================================
async function getProfile(req, res, next) {
  try {
    const profile = await userService.getFullProfile(req.user.id);
    if (!profile) return R.notFound(res, 'User not found.');
    return R.ok(res, { profile });
  } catch (err) { next(err); }
}

// =============================================================================
// PUT /api/v1/user/profile
// =============================================================================
async function updateProfile(req, res, next) {
  try {
    const { name, email } = req.body;
    await userService.updateBasicInfo(req.user.id, { name, email });
    const profile = await userService.getFullProfile(req.user.id);
    return R.ok(res, { profile }, 'Profile updated successfully.');
  } catch (err) { next(err); }
}

// =============================================================================
// PUT /api/v1/user/profile/image
// =============================================================================
async function updateProfileImage(req, res, next) {
  try {
    const { image_url } = req.body;
    if (!image_url) return R.badRequest(res, 'image_url is required.');
    await userService.updateProfileImage(req.user.id, image_url);
    return R.ok(res, { image_url }, 'Profile image updated.');
  } catch (err) { next(err); }
}

// =============================================================================
// GET /api/v1/user/addresses
// =============================================================================
async function getAddresses(req, res, next) {
  try {
    const addresses = await userService.getAllAddresses(req.user.id);
    return R.ok(res, { addresses });
  } catch (err) { next(err); }
}

// =============================================================================
// PUT /api/v1/user/addresses/primary
// =============================================================================
async function updatePrimaryAddress(req, res, next) {
  try {
    const { house_no, address, city, state, pin_code } = req.body;
    await userService.upsertPrimaryAddress(req.user.id, { house_no, address, city, state, pin_code });
    return R.ok(res, null, 'Primary address updated.');
  } catch (err) { next(err); }
}

// =============================================================================
// POST /api/v1/user/addresses
// =============================================================================
async function addAddress(req, res, next) {
  try {
    const { label, house_no, address, city, state, pin_code } = req.body;
    const result = await userService.addAddress(req.user.id, { label, house_no, address, city, state, pin_code });
    return R.created(res, { id: result.id }, 'Address added.');
  } catch (err) { next(err); }
}

// =============================================================================
// DELETE /api/v1/user/addresses/:id
// =============================================================================
async function deleteAddress(req, res, next) {
  try {
    const addressId = parseInt(req.params.id);
    if (isNaN(addressId)) return R.badRequest(res, 'Invalid address ID.');
    const deleted = await userService.deleteAddress(req.user.id, addressId);
    if (!deleted) return R.badRequest(res, 'Address not found or cannot delete the primary address.');
    return R.ok(res, null, 'Address deleted.');
  } catch (err) { next(err); }
}

// =============================================================================
// GET /api/v1/user/kyc
// =============================================================================
async function getKycStatus(req, res, next) {
  try {
    const kyc = await userService.getKycStatus(req.user.id);
    return R.ok(res, { kyc: kyc || { status: 'not_submitted' } });
  } catch (err) { next(err); }
}

// =============================================================================
// POST /api/v1/user/kyc
// Accepts base64-encoded document data directly in the request body.
// The Flutter app converts picked files to base64 before sending.
// =============================================================================
async function submitKyc(req, res, next) {
  try {
    const {
      address_proof_type,
      address_proof_data,   // base64 string
      address_proof_mime,   // e.g. "image/jpeg", "application/pdf"
      id_proof_type,
      id_proof_data,        // base64 string
      id_proof_mime,
    } = req.body;

    // Don't allow resubmission if already approved
    const existing = await userService.getKycStatus(req.user.id);
    if (existing && existing.status === 'approved') {
      return R.conflict(res, 'KYC is already approved. No changes needed.');
    }

    const id = await userService.submitKyc(req.user.id, {
      address_proof_type,
      address_proof_data,
      address_proof_mime,
      id_proof_type,
      id_proof_data,
      id_proof_mime,
    });

    return R.created(
      res,
      {
        submission_id: id,
        kyc: { status: 'pending', address_proof_type, id_proof_type },
      },
      'KYC documents submitted. We will notify you once reviewed.'
    );
  } catch (err) { next(err); }
}

// =============================================================================
// GET /api/v1/user/notifications
// =============================================================================
async function getNotifications(req, res, next) {
  try {
    const page  = parseInt(req.query.page  || '1');
    const limit = parseInt(req.query.limit || '20');
    const { notifications, total, unread } = await userService.getNotifications(
      req.user.id, { page, limit }
    );
    return R.ok(res, { notifications }, 'OK', 200, {
      page, limit, total, unread,
      total_pages: Math.ceil(total / limit),
    });
  } catch (err) { next(err); }
}

// =============================================================================
// PATCH /api/v1/user/notifications/read
// =============================================================================
async function markRead(req, res, next) {
  try {
    const ids = req.body.ids || null;
    await userService.markNotificationsRead(req.user.id, ids);
    return R.ok(res, null, 'Notifications marked as read.');
  } catch (err) { next(err); }
}

// =============================================================================
// GET /api/v1/user/referrals
// =============================================================================
async function getReferralStats(req, res, next) {
  try {
    const data = await userService.getReferralStats(req.user.id);
    return R.ok(res, data);
  } catch (err) { next(err); }
}

module.exports = {
  getProfile,
  updateProfile,
  updateProfileImage,
  getAddresses,
  updatePrimaryAddress,
  addAddress,
  deleteAddress,
  getKycStatus,
  submitKyc,
  getNotifications,
  markRead,
  getReferralStats,
};