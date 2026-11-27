import { Schema, model, models } from "mongoose";

export const DEAD_LETTER_STATUSES = [
  "open",
  "replaying",
  "replayed",
  "discarded",
] as const;

export type DeadLetterStatus = (typeof DEAD_LETTER_STATUSES)[number];

const DeadLetterSchema = new Schema(
  {
    queue: { type: String, required: true },
    jobName: { type: String, required: true },
    jobId: { type: String, required: true },
    data: { type: Schema.Types.Mixed, required: true },
    error: { type: String, required: true },
    stack: { type: String },
    failedAt: { type: Date, required: true, default: Date.now },
    status: {
      type: String,
      enum: DEAD_LETTER_STATUSES,
      default: "open",
      index: true,
    },
    replayedAt: { type: Date },
    replayedBy: { type: Schema.Types.ObjectId, ref: "User" },
    replayJobId: { type: String },
  },
  { timestamps: true, collection: "dead_letters" },
);

DeadLetterSchema.index({ queue: 1, jobId: 1 }, { unique: true });

export default models.DeadLetter || model("DeadLetter", DeadLetterSchema);
