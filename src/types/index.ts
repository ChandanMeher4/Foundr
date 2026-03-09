// src/types/index.ts
import { Types } from "mongoose";

export interface IProject {
  _id: string;
  title: string;
  description: string;
  developerName?: { _id: string; name: string } | any;

  // THE FIX: Tell TypeScript this is now a GeoJSON object!
  location: {
    type: string;
    coordinates: number[];
    address: string;
  };
  distance? : number;

  category: string;
  constructionStage: string;
  totalValuation: number;
  minInvestment: number;
  expectedCompletion: string | Date;
  currentFunding: number;
  imageUrls: string[];
  status: string;
  isVerified?: boolean;

  investors?: {
    userId: string | any;
    amount: number;
    date: string | Date;
  }[];
}

export interface IContact {
  _id?: string;
  name: string;
  email: string;
  message: string;
  createdAt?: Date;
}

// New: You also need a User interface for the Developer accounts
export interface IUser {
  _id: string;
  name: string; // Company Name
  email: string;
  role: "Developer" | "Admin";
  isVerifiedDeveloper: boolean;
}
