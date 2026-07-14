const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { searchDoctors, getAvailableSlots } = require('../controllers/patientController');

router.get('/', authenticate, searchDoctors);
router.get('/:id/slots', authenticate, getAvailableSlots);

module.exports = router;
