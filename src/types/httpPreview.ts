export type HttpServiceInfo = {
  id: number;
  root: string;
  port: number;
  url: string;
};

export type HttpServicesSnapshot = {
  revision: number;
  services: HttpServiceInfo[];
};

export type HtmlPreviewStarted = {
  snapshot: HttpServicesSnapshot;
  url: string;
};
