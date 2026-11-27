import mongoose, { Schema, model, models } from "mongoose";

const ProjectSchema = new Schema(
  {
    title: { type: String, required: true },
    description: { type: String, required: true },
    developerName: { type: Schema.Types.ObjectId, ref: "User", required: true },

    // GeoJSON Location Object
    location: {
      type: { type: String, enum: ["Point"], default: "Point", required: true },
      coordinates: { type: [Number], required: true }, // [longitude, latitude]
      address: { type: String, required: true },
    },

    category: {
      type: String,
      enum: ["Residential", "Commercial", "Plot"],
      required: true,
    },

    constructionStage: {
      type: String,
      enum: ["Planning", "Foundation", "Structural", "Finishing"],
      default: "Planning",
    },
    totalValuation: { type: Number, required: true },
    minInvestment: { type: Number, required: true },
    expectedCompletion: { type: Date, required: true },

    fundingGoal: { type: Number, default: 0 },
    currentFunding: { type: Number, default: 0 },
    reservedFunding: { type: Number, default: 0 },
    reservations: [
      {
        reservationId: { type: String, required: true },
        userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
        amount: { type: Number, required: true },
        idempotencyKey: { type: String, required: true },
        razorpayOrderId: { type: String },
        status: { type: String, enum: ["pending"], default: "pending" },
        expiresAt: { type: Date, required: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    investors: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        amount: { type: Number, required: true },
        date: { type: Date, default: Date.now },
        idempotencyKey: { type: String },
      },
    ],
    roi: { type: Number, default: 0 },

    imageUrls: { type: [String], required: true },
    isVerified: { type: Boolean, default: false },
    approvedAt: { type: Date },
    status: {
      type: String,
      enum: ["Pending Review", "Live", "Funded", "Rejected", "Expired"],
      default: "Pending Review",
    },
  },
  { timestamps: true },
);

ProjectSchema.index({ location: "2dsphere" });
ProjectSchema.index({ "reservations.expiresAt": 1 });

export default models.Project || model("Project", ProjectSchema);
