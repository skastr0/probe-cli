import { Effect, Layer, ManagedRuntime } from "effect"
import { ArtifactStoreLive } from "./services/ArtifactStore"
import { DaemonClientLive } from "./services/DaemonClient"
import { LldbBridgeFactoryLive } from "./services/LldbBridge"
import { OutputPolicyLive } from "./services/OutputPolicy"
import { PerfServiceLive } from "./services/PerfService"
import { ProbeKernelLive } from "./services/ProbeKernel"
import { RealDeviceHarnessLive } from "./services/RealDeviceHarness"
import { SessionRegistryLive } from "./services/SessionRegistry"
import { SimulatorHarnessLive } from "./services/SimulatorHarness"

const BaseServicesLive = Layer.mergeAll(
  ArtifactStoreLive,
  OutputPolicyLive,
  SimulatorHarnessLive,
  RealDeviceHarnessLive,
  LldbBridgeFactoryLive,
)
const SessionRegistryProvided = SessionRegistryLive.pipe(Layer.provide(BaseServicesLive))
const PerfServiceProvided = PerfServiceLive.pipe(Layer.provide(Layer.mergeAll(ArtifactStoreLive, SessionRegistryProvided)))
const DaemonClientProvided = DaemonClientLive.pipe(Layer.provide(ArtifactStoreLive))
const KernelProvided = ProbeKernelLive.pipe(
  Layer.provide(Layer.mergeAll(BaseServicesLive, SessionRegistryProvided, PerfServiceProvided)),
)

export const ProbeLayer = Layer.mergeAll(
  BaseServicesLive,
  SessionRegistryProvided,
  PerfServiceProvided,
  DaemonClientProvided,
  KernelProvided,
)

const probeMemoMap = Effect.runSync(Layer.makeMemoMap)

export const probeRuntime = ManagedRuntime.make(ProbeLayer, probeMemoMap)
