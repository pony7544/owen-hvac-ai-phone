const express = require("express");
const router = express.Router();

const {
  getAvailableSlots,
  createAppointment,
  updateAppointment,
  cancelAppointment,
} = require("../services/calendarService");

// 查询空闲时间
router.get("/availability", async (req, res) => {
  try {
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ error: "date is required, format: YYYY-MM-DD" });
    }

    const slots = await getAvailableSlots(date);

    res.json({
      success: true,
      date,
      slots,
    });
  } catch (error) {
    console.error("availability error:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

// 创建预约
router.post("/", async (req, res) => {
  try {
    const {
      customerName,
      phone,
      address,
      serviceType,
      startDateTime,
      durationMinutes,
      notes,
    } = req.body;

    if (!customerName || !serviceType || !startDateTime) {
      return res.status(400).json({
        error: "customerName, serviceType, startDateTime are required",
      });
    }

    const result = await createAppointment({
      customerName,
      phone,
      address,
      serviceType,
      startDateTime,
      durationMinutes,
      notes,
    });

    res.json({
      success: true,
      event: result,
    });
  } catch (error) {
    console.error("create appointment error:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

// 修改预约
router.patch("/:eventId", async (req, res) => {
  try {
    const { eventId } = req.params;
    const result = await updateAppointment(eventId, req.body);

    res.json({
      success: true,
      event: result,
    });
  } catch (error) {
    console.error("update appointment error:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

// 删除预约
router.delete("/:eventId", async (req, res) => {
  try {
    const { eventId } = req.params;
    const result = await cancelAppointment(eventId);

    res.json({
      success: true,
      result,
    });
  } catch (error) {
    console.error("delete appointment error:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

module.exports = router;
