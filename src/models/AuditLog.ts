import mongoose, { Schema, model, models } from "mongoose";

const AuditLogSchema = new Schema(
  {
    investmentId: { type: String, required: true, unique: true, index: true },
    eventType: {
      type: String,
      enum: [
        "INVESTMENT_COMMITTED",
        "PROJECT_FUNDED",
        "PAYMENT_CAPTURED",
        "RESERVATION_RELEASED",
        "PAYMENT_REFUNDED",
        "PAYMENT_INTEGRITY_FAILED",
        "DEAD_LETTER_REPLAYED",
      ],
      required: true,
    },
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: false,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
      index: true,
    },
    amount: { type: Number, default: 0 },
    idempotencyKey: { type: String, index: true },
    ip: { type: String, default: "unknown" },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

export default models.AuditLog || model("AuditLog", AuditLogSchema);
