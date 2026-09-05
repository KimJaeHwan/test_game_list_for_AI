export {
  DESKTOP_ALLOWED_KEYS,
  DESKTOP_BRIDGE_PROTOCOL_VERSION,
  DESKTOP_FRAME_POLICY_VERSION,
  DESKTOP_INPUT_POLICY_VERSION,
  exactRecord,
  sameTargetIdentity,
  validateRegion,
  validateTargetIdentity,
} from "./contract.mjs";
export { DesktopWindowAdapter } from "./desktop-window-adapter.mjs";
export { NativeDesktopBridgeClient, DEFAULT_DESKTOP_BRIDGE_EXECUTABLE } from "./native-client.mjs";
export {
  TARGET_BINDING_ERROR_CODES,
  TargetBindingBroker,
  TargetBindingError,
} from "./targeting/index.mjs";
export {
  SafeInputBroker,
  createLegacyBridgeInputProvider,
  normalizeInputProviderResult,
  validateInputProvider,
  validatePrivateAction,
} from "./input/index.mjs";
export {
  CAPTURE_BROKER_ERROR_CODES,
  CaptureBroker,
  CaptureBrokerError,
} from "./capture/index.mjs";
export {
  createLegacyBridgeCaptureProvider,
  createProviderLifecycle,
  validateCaptureProvider,
  validateProviderId,
} from "./provider-contract.mjs";
