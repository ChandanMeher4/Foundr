import { Schema, model, models } from "mongoose";

const WebhookEventSchema = new Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    event: { type: String, required: true, index: true },
    payload: { type: Schema.Types.Mixed, required: true },
    receivedAt: { type: Date, required: true, default: Date.now },
    processedAt: { type: Date, default: null, index: true },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true, collection: "webhook_events" },
);

WebhookEventSchema.index({ processedAt: 1, receivedAt: 1 });

export default models.WebhookEvent || model("WebhookEvent", WebhookEventSchema);
