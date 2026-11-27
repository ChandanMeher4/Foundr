import { Schema, model, models } from "mongoose";

export const PAYMENT_STATUSES = [
  "created",
  "authorized",
  "captured",
  "failed",
  "expired",
  "refund_pending",
  "refunded",
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

const PaymentSchema = new Schema(
  {
    reservationId: { type: String, required: true, unique: true, index: true },
    orderId: { type: String, required: true, unique: true, index: true },
    paymentId: { type: String, sparse: true, index: true },
    idempotencyKey: { type: String, index: true },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    amountPaise: {
      type: Number,
      required: true,
      validate: {
        validator: (v: number) => Number.isInteger(v) && v >= 100,
        message: "amountPaise must be an integer >= 100",
      },
    },
    currency: { type: String, default: "INR" },
    status: {
      type: String,
      enum: PAYMENT_STATUSES,
      default: "created",
      index: true,
    },
    expiresAt: { type: Date },
    refundId: { type: String },
    lastError: { type: String },
  },
  { timestamps: true },
);

PaymentSchema.index({ userId: 1, projectId: 1, idempotencyKey: 1 });

export default models.Payment || model("Payment", PaymentSchema);
