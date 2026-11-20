export type GitTab = "changes" | "history" | "info";

export type GitHistoryCommit = {
  sha: string;
  summary: string;
  author: string;
  authorTime: number;
};

export type GitHistoryPage = {
  head: string | null;
  commits: GitHistoryCommit[];
  hasMore: boolean;
};

export type GitHistoryQuery = {
  head?: string | null;
  skip: number;
  limit: number;
};
