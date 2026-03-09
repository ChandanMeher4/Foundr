import mongoose, { Schema, model, models } from "mongoose";

const UserSchema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },

    // The select: false is a crucial security measure.
    // It ensures Mongoose never accidentally sends the hashed password to the frontend.
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
      default: "Bengaluru", // A solid default hub for tech and real estate!
    },

    // Interactive features: Storing the IDs of projects they like
    starredProjects: [{ type: Schema.Types.ObjectId, ref: "Project" }],

    // Optional: Only used if the role is "Developer"
    companyName: { type: String, default: "" },

    otp: { type: String },
    otpExpiry: { type: Date },
  },
  { timestamps: true },
);

export default models.User || model("User", UserSchema);
