import mongoose, { Schema, model, models } from "mongoose";

const UserSchema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true, select: false },

    // Role-Based Access Control (RBAC)
    role: {
      type: String,
      enum: ["Investor", "Developer", "Admin"],
      default: "Investor",
    },

    // Location-based filtering
    city: {
      type: String,
      required: true,
      default: "Bengaluru", 
    },

    // Storing the IDs of projects liked
    starredProjects: [{ type: Schema.Types.ObjectId, ref: "Project" }],

    // Only used if Developer
    companyName: { type: String, default: "" },

    otp: { type: String },
    otpExpiry: { type: Date },
  },
  { timestamps: true },
);

export default models.User || model("User", UserSchema);
