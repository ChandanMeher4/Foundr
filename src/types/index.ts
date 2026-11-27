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
  imageUrls: string[];
  status: "Pending Review" | "Live" | "Funded" | "Rejected" | "Expired" | string;
  isVerified?: boolean;
  approvedAt?: string | Date;

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
