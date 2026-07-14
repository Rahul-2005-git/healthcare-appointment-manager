const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { connect, status, callback } = require('../controllers/calendarController');

router.get('/google/connect', authenticate, connect);
router.get('/google/status', authenticate, status);
router.get('/google/callback', callback); // public — Google redirects here directly

module.exports = router;
