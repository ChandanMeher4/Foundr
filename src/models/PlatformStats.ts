import { Schema, model, models } from "mongoose";

const PlatformStatsSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, default: "latest" },
    liveListings: { type: Number, required: true },
    fundedListings: { type: Number, required: true },
    totalCommitted: { type: Number, required: true },
    investorCount: { type: Number, required: true },
    newUsersLast7Days: { type: Number, required: true },
    computedAt: { type: Date, required: true },
  },
  { timestamps: true, collection: "platform_stats" },
);

export default models.PlatformStats || model("PlatformStats", PlatformStatsSchema);
