const router = require('express').Router();
const { authenticate, authorize } = require('../middleware/auth');
const {
  holdSlot, confirmBooking, cancelAppointment, listMine, listForDoctor, submitPostVisit,
} = require('../controllers/appointmentController');

router.use(authenticate);

router.post('/hold', authorize('patient'), holdSlot);
router.post('/confirm', authorize('patient'), confirmBooking);
router.post('/:id/cancel', cancelAppointment); // patient, doctor, or admin — checked in controller
router.post('/:id/post-visit', authorize('doctor'), submitPostVisit);
router.get('/mine', authorize('patient'), listMine);
router.get('/doctor', authorize('doctor'), listForDoctor);

module.exports = router;
