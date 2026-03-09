import mongoose, { Schema, model, models } from "mongoose";

const ProjectSchema = new Schema(
  {
    title: { type: String, required: true },
    description: { type: String, required: true },
    developerName: { type: Schema.Types.ObjectId, ref: "User", required: true },

    // The GeoJSON Location Object
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

    // NEW: Aligning with your updated form fields
    constructionStage: {
      type: String,
      enum: ["Planning", "Foundation", "Structural", "Finishing"],
      default: "Planning",
    },
    totalValuation: { type: Number, required: true },
    minInvestment: { type: Number, required: true },
    expectedCompletion: { type: Date, required: true },

    // Legacy fields (optional based on your UI needs)
    fundingGoal: { type: Number, default: 0 },
    currentFunding: { type: Number, default: 0 },
    investors: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        amount: { type: Number, required: true },
        date: { type: Date, default: Date.now },
      },
    ],
    roi: { type: Number, default: 0 },

    imageUrls: { type: [String], required: "true" },
    status: {
      type: String,
      enum: ["Pending Review", "Live", "Rejected"],
      default: "Pending Review",
    },
  },
  { timestamps: true },
);

ProjectSchema.index({ location: "2dsphere" });

export default models.Project || model("Project", ProjectSchema);
