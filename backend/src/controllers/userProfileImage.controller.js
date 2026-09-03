const mongoose = require('mongoose');
const User = require('../models/User');
const profileImageStorage = require('../services/profileImageStorage');
const { sanitizeUser } = require('./auth.controller');

/**
 * DOC-71 - "Enhanced User Profile: Profile Picture + Bio" - profile image
 * endpoints.
 * -------------------------------------------------------------------------
 *   POST   /api/users/me/profile-image        - current user only, replaces
 *   DELETE /api/users/me/profile-image        - current user only, clears
 *   GET    /api/users/:userId/profile-image   - self, or same-Organization
 *                                                authenticated users
 *
 * SELF-SERVICE DERIVATION (task spec section 10 - "Do NOT trust user id
 * for self update"). Upload/delete both derive the target EXCLUSIVELY from
 * `req.user.userId` (middleware/auth.js's own verified, database-backed
 * context) - there is no `:userId` in either route at all, so it is
 * structurally impossible to upload/delete on behalf of another user
 * regardless of what a client sends. This is the exact same "derive
 * identity from trusted server-side context, never from req.params" shape
 * PATCH /api/users/me (DOC-62) already established.
 */

// Task spec section 8 - "Manager/Operator/Employee avatars may be visible
// to authenticated users in the same Organization. System Admin avatar
// only where relevant." Implemented as a single rule, never role-specific:
// a caller may always view their OWN image, and otherwise only an image
// belonging to a user who shares their own REAL (non-null) organizationId.
// This naturally satisfies both halves of the recommendation without a
// special case: two Organization-scoped users (Manager/Operator/Employee)
// in the same Organization can see each other; a System Admin (whose own
// organizationId is always null) can never match anyone else's
// organizationId, so nobody else can view a System Admin's avatar, and a
// System Admin cannot view anyone else's - each can still always view
// their OWN, task spec section 21's requirement. This mirrors this
// project's running "do not create new operational System Admin
// permissions" principle rather than special-casing System Admin as a
// cross-Organization viewer.
function canViewProfileImage({ viewerId, viewerOrganizationId, targetId, targetOrganizationId }) {
  if (String(viewerId) === String(targetId)) {
    return true;
  }
  return (
    viewerOrganizationId != null
    && targetOrganizationId != null
    && String(viewerOrganizationId) === String(targetOrganizationId)
  );
}

// POST /api/users/me/profile-image
//
// `req.file` comes from middleware/upload.js's existing `uploadMemory`
// Multer instance (memoryStorage - the buffer only ever exists in memory,
// never touches local disk, never Base64) wrapped in `handleUpload` (task
// spec section 6/30 - the SAME MIME/size validation Request images already
// use, reused as-is: JPEG/PNG/WEBP only, 5 MB max - no separate, looser
// profile-image-specific rule was introduced).
//
// REPLACEMENT ORDER (task spec section 7/26 - "Avoid a flow where deletion
// of the old image happens before the new image is confirmed stored"):
//   1. upload the NEW image to storage (may fail - nothing is touched yet)
//   2. save the User document's new `profileImage` reference (may fail -
//      the new image is now an orphan in storage, acceptable per this
//      file's own documented cleanup tradeoff, but the OLD image is still
//      completely intact and still the User's current image)
//   3. ONLY once (1) and (2) have both already succeeded, best-effort
//      delete the OLD image's bytes - a failure here is logged and
//      swallowed, never surfaced as this request's own error (task spec:
//      "Failure cleaning old binary does not break new profile update").
const uploadMyProfileImage = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ status: 'error', message: 'A profile image file is required.' });
    }

    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found.' });
    }

    const previousProfileImage = user.profileImage;

    const reference = await profileImageStorage.uploadImage(req.file.buffer, {
      userId: user._id,
      mimeType: req.file.mimetype,
    });

    user.profileImage = {
      ...reference,
      mimeType: req.file.mimetype,
      size: req.file.size,
    };
    await user.save();

    // Best-effort cleanup, AFTER the new reference is already durably
    // saved above - see this function's own top comment.
    if (previousProfileImage) {
      await profileImageStorage.deleteImage(previousProfileImage);
    }

    return res.status(201).json({ status: 'success', data: sanitizeUser(user) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// DELETE /api/users/me/profile-image (task spec section 27)
//
// Idempotent (task spec section 35 item 28 - "repeated delete behaves
// safely"): a user with no profile image already gets the same 200
// success response, never an error - clearing "nothing" is not a failure.
const deleteMyProfileImage = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found.' });
    }

    const previousProfileImage = user.profileImage;
    if (!previousProfileImage) {
      return res.status(200).json({ status: 'success', data: sanitizeUser(user) });
    }

    user.profileImage = null;
    await user.save();

    // Best-effort - see uploadMyProfileImage's own comment on this same
    // tradeoff.
    await profileImageStorage.deleteImage(previousProfileImage);

    return res.status(200).json({ status: 'success', data: sanitizeUser(user) });
  } catch (error) {
    return next(error);
  }
};

// GET /api/users/:userId/profile-image (task spec section 9/31)
//
// Streams the image bytes through this authenticated endpoint - the exact
// same "never a raw/public storage URL, always proxied through Node with
// an authorization check first" pattern
// request.controller.js's getRequestAttachmentContent already established
// for Request images (see AuthenticatedRequestImage.jsx's own comment on
// why: no cookie-based session in this project, so a plain `<img src>`
// cannot attach the required Authorization header - the frontend fetches
// this with its own token and builds an object URL, exactly like it
// already does for Request images).
const getUserProfileImageContent = async (req, res, next) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ status: 'error', message: 'Invalid user id.' });
    }

    // A nonexistent user and one whose image this caller is not authorized
    // to view both collapse into the same 404 below - never revealing
    // which (task spec section 31/37: "no direct storage URL should bypass
    // authorization" / cross-org enumeration).
    const targetUser = await User.findById(userId);
    if (!targetUser) {
      return res.status(404).json({ status: 'error', message: 'Profile image not found.' });
    }

    const authorized = canViewProfileImage({
      viewerId: req.user.userId,
      viewerOrganizationId: req.user.organizationId,
      targetId: targetUser._id,
      targetOrganizationId: targetUser.organizationId,
    });
    if (!authorized) {
      // Same 404 as "no such user"/"no such image" - never a distinguishing
      // 403 here, since that would itself confirm the target user exists
      // in another Organization (task spec section 31's own cross-org
      // enumeration concern).
      return res.status(404).json({ status: 'error', message: 'Profile image not found.' });
    }

    if (!targetUser.profileImage) {
      return res.status(404).json({ status: 'error', message: 'Profile image not found.' });
    }

    const imageStream = await profileImageStorage.getImageStream(targetUser.profileImage);
    if (!imageStream) {
      return res.status(404).json({ status: 'error', message: 'Profile image not found.' });
    }

    res.setHeader('Content-Type', imageStream.contentType);
    if (imageStream.contentLength) {
      res.setHeader('Content-Length', String(imageStream.contentLength));
    }
    res.setHeader('Content-Disposition', 'inline');
    // Task spec section 28 - a long, safe cache lifetime is fine PRECISELY
    // BECAUSE the URL itself is cache-busted with the image's own
    // `updatedAt` version (see auth.controller.js's `sanitizeProfileImage`)
    // - a replaced image gets a brand-new URL, so this header never serves
    // stale bytes; it is not a global "disable all caching" change.
    res.setHeader('Cache-Control', 'private, max-age=86400');

    imageStream.stream.on('error', (error) => next(error));
    return imageStream.stream.pipe(res);
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  uploadMyProfileImage,
  deleteMyProfileImage,
  getUserProfileImageContent,
  canViewProfileImage,
};
