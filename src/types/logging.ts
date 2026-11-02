export type ErrorLogContext = {
  command?: string;
  path?: string;
  operationId?: string;
  stack?: string;
  omitDetails?: boolean;
};

export type NormalizedLogError = {
  code?: string;
  message: string;
  stack?: string;
};
