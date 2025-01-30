import { Service, IBrowserService, ServiceType, IAgentRuntime } from '@elizaos/core';

type PageContent = {
    title: string;
    description: string;
    bodyContent: string;
};
declare class BrowserService extends Service implements IBrowserService {
    private browser;
    private context;
    private blocker;
    private captchaSolver;
    private cacheKey;
    static serviceType: ServiceType;
    static register(runtime: IAgentRuntime): IAgentRuntime;
    getInstance(): IBrowserService;
    constructor();
    initialize(): Promise<void>;
    initializeBrowser(): Promise<void>;
    closeBrowser(): Promise<void>;
    getPageContent(url: string, runtime: IAgentRuntime): Promise<PageContent>;
    private getCacheKey;
    private fetchPageContent;
    private detectCaptcha;
    private solveCaptcha;
    private getHCaptchaWebsiteKey;
    private getReCaptchaWebsiteKey;
    private tryAlternativeSources;
}

declare const browserPlugin: {
    name: string;
    description: string;
    services: BrowserService[];
    actions: never[];
};

export { browserPlugin, browserPlugin as default };
