import protocol from "../../lib/runtime/executor-protocol.json";

export const appOrigin = "http://127.0.0.1:3100";
export const singleUserStorageOwner = "access:single_user";
export const singleUserStorageKey =
  `scenecart-dashboard-state:v2:${encodeURIComponent(singleUserStorageOwner)}`;

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Playwright single-user fixture is missing ${name}`);
  return value;
}

export const moduleOnlyDevice = Object.freeze({
  id: required("SCENECART_E2E_MODULE_DEVICE_ID"),
  token: required("SCENECART_E2E_MODULE_DEVICE_TOKEN")
});

export const fullCapabilityDevice = Object.freeze({
  id: required("SCENECART_E2E_FULL_DEVICE_ID"),
  token: required("SCENECART_E2E_FULL_DEVICE_TOKEN")
});

export function executorHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "X-SceneCart-Executor-Protocol": protocol.version,
    Origin: appOrigin
  };
}

