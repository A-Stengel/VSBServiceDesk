// Who this service desk is for (Settings > System > Organization). The values
// come with the pick-lists after sign-in; this browser keeps the last ones so
// the sign-in and loading screens can use them before then.
const KEY = "organization";
const DEFAULTS = { appName: "Service Desk", organizationName: "", mailboxAddress: "", staffDomains: "" };

export function organization() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return DEFAULTS;
  }
}

export function rememberOrganization(values) {
  const next = { ...DEFAULTS, ...values };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private windows can refuse storage; the defaults still work
  }
  document.title = next.appName;
}
