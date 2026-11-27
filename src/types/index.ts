export interface IProjectInvestor {
  _id?: string;
  userId:
    | string
    | {
        _id: string;
        name?: string;
        email?: string;
      };
  amount: number;
  date: string | Date;
  idempotencyKey?: string;
}

export interface IProjectReservation {
  _id?: string;
  reservationId: string;
  userId: string;
  amount: number;
  idempotencyKey: string;
  razorpayOrderId?: string;
  status: "pending";
  expiresAt: string | Date;
  createdAt?: string | Date;
}

export type PaymentStatus =
  | "created"
  | "authorized"
  | "captured"
  | "failed"
  | "expired"
  | "refund_pending"
  | "refunded";

export interface IPaymentSummary {
  _id: string;
  reservationId: string;
  orderId: string;
  paymentId?: string;
  amountPaise: number;
  currency?: string;
  status: PaymentStatus;
  createdAt?: string | Date;
  projectId?:
    | {
        _id: string;
        title?: string;
        status?: string;
        category?: string;
      }
    | string;
}

export interface IDeadLetterItem {
  _id: string;
  queue: string;
  jobName: string;
  jobId: string;
  error: string;
  failedAt: string | Date;
  status: "open" | "replaying" | "replayed" | "discarded";
}

export interface IProject {
  _id: string;
  title: string;
  description: string;
  developerName?:
    | {
        _id: string;
        name: string;
        email?: string;
        isVerifiedDeveloper?: boolean;
      }
    | string;

  location: {
    type: string;
    coordinates: number[];
    address: string;
  };
  distance?: number;

  category: "Residential" | "Commercial" | "Plot" | string;
  constructionStage: string;
  totalValuation: number;
  minInvestment: number;
  expectedCompletion: string | Date;
  currentFunding: number;
  reservedFunding?: number;
  reservations?: IProjectReservation[];
  imageUrls: string[];
  status: "Pending Review" | "Live" | "Funded" | "Rejected" | "Expired" | string;
  isVerified?: boolean;
  approvedAt?: string | Date;
  trendingScore?: number;

  investors?: IProjectInvestor[];
}

export interface IContact {
  _id?: string;
  name: string;
  email: string;
  message: string;
  createdAt?: Date;
}

export interface IUser {
  _id: string;
  name: string;
  email: string;
  role: "Investor" | "Developer" | "Admin";
  city?: string;
  companyName?: string;
  digestOptIn?: boolean;
  isVerifiedDeveloper?: boolean;
  starredProjects?: IProject[] | string[];
}
