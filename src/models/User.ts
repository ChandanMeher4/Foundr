import { Schema, model, models } from "mongoose";
import { revokeAllUserSessions } from "../lib/revocation";

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

    // Daily new-listing digest opt-in
    digestOptIn: { type: Boolean, default: true },

    // Storing the IDs of projects liked
    starredProjects: [{ type: Schema.Types.ObjectId, ref: "Project" }],

    // Only used if Developer
    companyName: { type: String, default: "" },
  },
  { timestamps: true },
);

// Automatically revoke all active sessions whenever an existing user's role changes
UserSchema.pre("save", function () {
  if (!this.isNew && this.isModified("role")) {
    this.$locals.roleChanged = true;
  }
});

UserSchema.post("save", async function (doc) {
  if (doc.$locals?.roleChanged && doc._id) {
    await revokeAllUserSessions(doc._id.toString());
  }
});

UserSchema.post("findOneAndUpdate", async function (doc) {
  const rawUpdate = this.getUpdate() as
    | { role?: unknown; $set?: { role?: unknown } }
    | null;
  const updatedRole = rawUpdate?.role ?? rawUpdate?.$set?.role;
  if (updatedRole !== undefined && doc?._id) {
    await revokeAllUserSessions(doc._id.toString());
  }
});

export default models.User || model("User", UserSchema);
