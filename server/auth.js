const { sendError } = require('./errors');

function requireAuth(req, res, next) {
  if (!req.session?.user) return sendError(res, 'UNAUTHENTICATED');
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.session?.user?.role !== role) return sendError(res, 'FORBIDDEN', `This needs a ${role} account.`);
    next();
  };
}

module.exports = { requireAuth, requireRole };
