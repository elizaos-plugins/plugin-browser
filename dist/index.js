// src/services/browser.ts
import { generateText, trimTokens } from "@elizaos/core";
import { parseJSONObjectFromText } from "@elizaos/core";
import { Service } from "@elizaos/core";
import { settings } from "@elizaos/core";
import { ModelClass, ServiceType } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { PlaywrightBlocker } from "@cliqz/adblocker-playwright";
import CaptchaSolver from "capsolver-npm";
import { chromium } from "playwright";
import { elizaLogger } from "@elizaos/core";
async function generateSummary(runtime, text) {
  text = await trimTokens(text, 1e5, runtime);
  const prompt = `Please generate a concise summary for the following text:

  Text: """
  ${text}
  """

  Respond with a JSON object in the following format:
  \`\`\`json
  {
    "title": "Generated Title",
    "summary": "Generated summary and/or description of the text"
  }
  \`\`\``;
  const response = await generateText({
    runtime,
    context: prompt,
    modelClass: ModelClass.SMALL
  });
  const parsedResponse = parseJSONObjectFromText(response);
  if (parsedResponse) {
    return {
      title: parsedResponse.title,
      description: parsedResponse.summary
    };
  }
  return {
    title: "",
    description: ""
  };
}
var _BrowserService = class _BrowserService extends Service {
  constructor() {
    super();
    this.cacheKey = "content/browser";
    this.browser = void 0;
    this.context = void 0;
    this.blocker = void 0;
    this.captchaSolver = new CaptchaSolver(settings.CAPSOLVER_API_KEY || "");
  }
  static register(runtime) {
    return runtime;
  }
  getInstance() {
    return _BrowserService.getInstance();
  }
  async initialize() {
  }
  async initializeBrowser() {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        args: [
          "--disable-dev-shm-usage",
          // Uses /tmp instead of /dev/shm. Prevents memory issues on low-memory systems
          "--block-new-web-contents"
          // Prevents creation of new windows/tabs
        ]
      });
      const platform = process.platform;
      let userAgent = "";
      switch (platform) {
        case "darwin":
          userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
          break;
        case "win32":
          userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
          break;
        case "linux":
          userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
          break;
        default:
          userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
      }
      this.context = await this.browser.newContext({
        userAgent,
        acceptDownloads: false
      });
      this.blocker = await PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch);
    }
  }
  async closeBrowser() {
    if (this.context) {
      await this.context.close();
      this.context = void 0;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = void 0;
    }
  }
  async getPageContent(url, runtime) {
    await this.initializeBrowser();
    return await this.fetchPageContent(url, runtime);
  }
  getCacheKey(url) {
    return stringToUuid(url);
  }
  async fetchPageContent(url, runtime) {
    const cacheKey = this.getCacheKey(url);
    const cached = await runtime.cacheManager.get(`${this.cacheKey}/${cacheKey}`);
    if (cached) {
      return cached.content;
    }
    let page;
    try {
      if (!this.context) {
        elizaLogger.log("Browser context not initialized. Call initializeBrowser() first.");
      }
      page = await this.context.newPage();
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9"
      });
      if (this.blocker) {
        await this.blocker.enableBlockingInPage(page);
      }
      const response = await page.goto(url, { waitUntil: "networkidle" });
      if (!response) {
        elizaLogger.error("Failed to load the page");
      }
      if (response.status() === 403 || response.status() === 404) {
        return await this.tryAlternativeSources(url, runtime);
      }
      const captchaDetected = await this.detectCaptcha(page);
      if (captchaDetected) {
        await this.solveCaptcha(page, url);
      }
      const documentTitle = await page.evaluate(() => document.title);
      const bodyContent = await page.evaluate(() => document.body.innerText);
      const { title: parsedTitle, description } = await generateSummary(runtime, documentTitle + "\n" + bodyContent);
      const content = { title: parsedTitle, description, bodyContent };
      await runtime.cacheManager.set(`${this.cacheKey}/${cacheKey}`, {
        url,
        content
      });
      return content;
    } catch (error) {
      elizaLogger.error("Error:", error);
      return {
        title: url,
        description: "Error, could not fetch content",
        bodyContent: ""
      };
    } finally {
      if (page) {
        await page.close();
      }
    }
  }
  async detectCaptcha(page) {
    const captchaSelectors = ['iframe[src*="captcha"]', 'div[class*="captcha"]', "#captcha", ".g-recaptcha", ".h-captcha"];
    for (const selector of captchaSelectors) {
      const element = await page.$(selector);
      if (element) return true;
    }
    return false;
  }
  async solveCaptcha(page, url) {
    try {
      const hcaptchaKey = await this.getHCaptchaWebsiteKey(page);
      if (hcaptchaKey) {
        const solution = await this.captchaSolver.hcaptchaProxyless({
          websiteURL: url,
          websiteKey: hcaptchaKey
        });
        await page.evaluate((token) => {
          window.hcaptcha.setResponse(token);
        }, solution.gRecaptchaResponse);
        return;
      }
      const recaptchaKey = await this.getReCaptchaWebsiteKey(page);
      if (recaptchaKey) {
        const solution = await this.captchaSolver.recaptchaV2Proxyless({
          websiteURL: url,
          websiteKey: recaptchaKey
        });
        await page.evaluate((token) => {
          document.getElementById("g-recaptcha-response").innerHTML = token;
        }, solution.gRecaptchaResponse);
      }
    } catch (error) {
      elizaLogger.error("Error solving CAPTCHA:", error);
    }
  }
  async getHCaptchaWebsiteKey(page) {
    return page.evaluate(() => {
      const hcaptchaIframe = document.querySelector('iframe[src*="hcaptcha.com"]');
      if (hcaptchaIframe) {
        const src = hcaptchaIframe.getAttribute("src");
        const match = src?.match(/sitekey=([^&]*)/);
        return match ? match[1] : "";
      }
      return "";
    });
  }
  async getReCaptchaWebsiteKey(page) {
    return page.evaluate(() => {
      const recaptchaElement = document.querySelector(".g-recaptcha");
      return recaptchaElement ? recaptchaElement.getAttribute("data-sitekey") || "" : "";
    });
  }
  async tryAlternativeSources(url, runtime) {
    const archiveUrl = `https://web.archive.org/web/${url}`;
    try {
      return await this.fetchPageContent(archiveUrl, runtime);
    } catch (error) {
      elizaLogger.error("Error fetching from Internet Archive:", error);
    }
    const googleSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(url)}`;
    try {
      return await this.fetchPageContent(googleSearchUrl, runtime);
    } catch (error) {
      elizaLogger.error("Error fetching from Google Search:", error);
      elizaLogger.error("Failed to fetch content from alternative sources");
      return {
        title: url,
        description: "Error, could not fetch content from alternative sources",
        bodyContent: ""
      };
    }
  }
};
_BrowserService.serviceType = ServiceType.BROWSER;
var BrowserService = _BrowserService;

// src/index.ts
var browserPlugin = {
  name: "default",
  description: "Default plugin, with basic actions and evaluators",
  services: [new BrowserService()],
  actions: []
};
var index_default = browserPlugin;
export {
  browserPlugin,
  index_default as default
};
//# sourceMappingURL=index.js.map