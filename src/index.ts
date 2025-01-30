import {
    BrowserService,
} from "./services/browser"

export const browserPlugin = {
  name: "default",
  description: "Default plugin, with basic actions and evaluators",
  services: [new BrowserService()],
  actions: [],
};

export default browserPlugin;