import mongoose, { Schema, model, models } from "mongoose";

const AuditLogSchema = new Schema(
  {
    investmentId: { type: String, required: true, unique: true, index: true },
    eventType: {
      type: String,
      enum: ["INVESTMENT_COMMITTED", "PROJECT_FUNDED"],
      required: true,
    },
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    amount: { type: Number, required: true },
    ip: { type: String, default: "unknown" },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

export default models.AuditLog || model("AuditLog", AuditLogSchema);
