import { access, readdir, readFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { Context, Effect, Layer } from "effect"
import {
  buildCommerceDoctorReport,
  buildCommerceEnvironmentReport,
  buildCommerceValidationReport,
  isCommerceExecutableStep,
  rollupCommerceVerdict,
  validateCommerceValidationPlan,
  type CommerceCheck,
  type CommerceDoctorReport,
  type CommerceProvider,
  type CommerceValidationMode,
  type CommerceValidationPlan,
  type CommerceValidationReport,
  type CommerceValidationStepResult,
} from "../domain/commerce"
import type { SessionFlowResult } from "../domain/flow-v2"
import {
  ArtifactNotFoundError,
  ChildProcessError,
  DaemonNotRunningError,
  EnvironmentError,
  ProtocolMismatchError,
  SessionConflictError,
  SessionNotFoundError,
  UnsupportedCapabilityError,
  UserInputError,
  formatProbeError,
  isProbeError,
} from "../domain/errors"
import type { ArtifactRecord } from "../domain/output"
import { ArtifactStore } from "./ArtifactStore"
import { DaemonClient } from "./DaemonClient"

interface TextFileEntry {
  readonly path: string
  readonly text: string
}

interface RevenueCatPublicKeyMatch {
  readonly value: string
  readonly location: string
}

interface LocalRevenueCatPackageMapping {
  readonly offeringId: string
  readonly packageId: string
  readonly productIds: Array<string>
  readonly entitlements: Array<string>
  readonly sourcePath: string
}

interface LocalRevenueCatCatalogInspection {
  readonly configPaths: Array<string>
  readonly matchedConfigPaths: Array<string>
  readonly parseErrors: Array<string>
  readonly offeringIds: Array<string>
  readonly packages: Array<LocalRevenueCatPackageMapping>
}

interface StoreKitCatalogInspection {
  readonly productIds: Array<string>
  readonly parseErrors: Array<string>
}

const nowIso = (): string => new Date().toISOString()

const appStoreConnectStubDetail = "App Store Connect inspection is stubbed in this lane until Apple-side provider integration lands."
const firstSubmissionGateAction = "If the app has never shipped an approved subscription, attach the subscriptions to an app version and submit them for App Review before treating sandbox/TestFlight emptiness as a client bug."
const revenueCatAppleBoundaryDetail = "RevenueCat offerings and packages can resolve before Apple StoreKit fetches live products. If RevenueCat looks healthy but products still load empty, treat that as an Apple-side availability problem and inspect Apple TN3186/TN3188 before blaming RevenueCat."
const revenueCatValidationSequence = "RevenueCat validation sequence: getOfferings() -> choose the expected package -> confirm StoreKit-backed pricing -> purchasePackage() -> verify CustomerInfo entitlement -> restorePurchases() -> relaunch and re-check CustomerInfo."
const revenueCatNegativeCaseCoverage = "Negative cases still need coverage: purchase cancellation must not unlock entitlement, and double-tap buy must keep only one purchase operation in flight."

const workspaceConfigExtensionPattern = /\.(json|jsonc)$/i
const providerConfigPathPattern = /(revenuecat|offering|paywall|subscription|purchase|commerce|entitlement)/i
const revenueCatPublicKeyPattern = /\b(?:appl|test)_[A-Za-z0-9_]+\b/g
const storeKitProductFieldNames = new Set(["productId", "productID", "productIdentifier", "storeProductId", "storeProductID", "id", "identifier"])
const revenueCatProductFieldNames = new Set(["productId", "productID", "productIdentifier", "storeProductId", "storeProductID", "appleProductId", "apple_product_id", "id"])
const revenueCatEntitlementFieldNames = new Set(["entitlement", "entitlementId", "entitlementID", "entitlementIdentifier", "entitlements"])
const ignoredWorkspaceDirectoryNames = new Set([".git", ".agents", "node_modules", "Pods", "build", "coverage", "dist", ".next"])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const looksLikeProductId = (value: string): boolean =>
  value.includes(".") && !/\s/.test(value)

const redactRevenueCatKey = (value: string): string =>
  value.length <= 10
    ? `${value.slice(0, 5)}…`
    : `${value.slice(0, 5)}…${value.slice(-4)}`

const shouldSkipWorkspaceDirectory = (_path: string, name: string): boolean =>
  ignoredWorkspaceDirectoryNames.has(name)

const stripJsonComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")

const parseJsonDocument = (text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string } => {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (firstError) {
    try {
      return { ok: true, value: JSON.parse(stripJsonComments(text)) as unknown }
    } catch {
      return {
        ok: false,
        error: firstError instanceof Error ? firstError.message : String(firstError),
      }
    }
  }
}

const collectFieldStrings = (
  value: unknown,
  fieldNames: ReadonlySet<string>,
  predicate?: (value: string) => boolean,
): Array<string> => {
  const results: Array<string> = []

  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      if (predicate === undefined || predicate(candidate)) {
        results.push(candidate)
      }
      return
    }

    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item)
      }
      return
    }

    if (!isRecord(candidate)) {
      return
    }

    for (const [key, nested] of Object.entries(candidate)) {
      if (fieldNames.has(key)) {
        visit(nested)
      }

      visit(nested)
    }
  }

  visit(value)
  return unique(results)
}

const findValuesForKey = (value: unknown, key: string): Array<unknown> => {
  const matches: Array<unknown> = []

  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item)
      }
      return
    }

    if (!isRecord(candidate)) {
      return
    }

    if (key in candidate) {
      matches.push(candidate[key])
    }

    for (const nested of Object.values(candidate)) {
      visit(nested)
    }
  }

  visit(value)
  return matches
}

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const unique = <T>(values: ReadonlyArray<T>): Array<T> => [...new Set(values)]

const rel = (rootDir: string, path: string): string => {
  const relativePath = relative(rootDir, path)
  return relativePath.length > 0 ? relativePath : "."
}

const walkDirectory = async (
  root: string,
  predicate: (path: string, name: string) => boolean,
  options?: {
    readonly skipDirectory?: (path: string, name: string) => boolean
  },
): Promise<Array<string>> => {
  const results: Array<string> = []

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })

    for (const entry of entries) {
      const absolutePath = join(directory, entry.name)

      if (entry.isDirectory()) {
        if (options?.skipDirectory?.(absolutePath, entry.name)) {
          continue
        }

        await visit(absolutePath)
        continue
      }

      if (predicate(absolutePath, entry.name)) {
        results.push(absolutePath)
      }
    }
  }

  await visit(root)
  return results.sort()
}

const readTextEntries = async (paths: ReadonlyArray<string>): Promise<Array<TextFileEntry>> =>
  Promise.all(paths.map(async (path) => ({ path, text: await readFile(path, "utf8") })))

const inspectRevenueCatWorkspaceFiles = async (rootDir: string) => {
  const configPaths = await walkDirectory(
    rootDir,
    (absolutePath, name) => workspaceConfigExtensionPattern.test(name) && providerConfigPathPattern.test(absolutePath),
    { skipDirectory: shouldSkipWorkspaceDirectory },
  )

  return {
    configPaths,
    configEntries: await readTextEntries(configPaths),
  }
}

const collectRevenueCatPublicKeyMatches = (
  entries: ReadonlyArray<TextFileEntry>,
  rootDir: string,
): Array<RevenueCatPublicKeyMatch> => {
  const matches: Array<RevenueCatPublicKeyMatch> = []

  for (const entry of entries) {
    const lines = entry.text.split(/\r?\n/)

    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(revenueCatPublicKeyPattern)) {
        matches.push({
          value: match[0],
          location: `${rel(rootDir, entry.path)}:${index + 1}: ${redactRevenueCatKey(match[0])}`,
        })
      }
    }
  }

  return matches
}

const extractPackageMappings = (
  packagesNode: unknown,
  offeringId: string,
  sourcePath: string,
): Array<LocalRevenueCatPackageMapping> => {
  const mappings: Array<LocalRevenueCatPackageMapping> = []

  const addPackage = (packageIdHint: string, value: unknown, index: number): void => {
    if (!isRecord(value)) {
      return
    }

    const packageId = [value.identifier, value.packageId, value.package, value.id]
      .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)
      ?? packageIdHint
      ?? `package-${index + 1}`

    mappings.push({
      offeringId,
      packageId,
      productIds: collectFieldStrings(value, revenueCatProductFieldNames, looksLikeProductId),
      entitlements: collectFieldStrings(value, revenueCatEntitlementFieldNames, (candidate) => candidate.trim().length > 0),
      sourcePath,
    })
  }

  if (Array.isArray(packagesNode)) {
    packagesNode.forEach((entry, index) => addPackage(`package-${index + 1}`, entry, index))
    return mappings
  }

  if (!isRecord(packagesNode)) {
    return mappings
  }

  Object.entries(packagesNode).forEach(([packageId, value], index) => addPackage(packageId, value, index))
  return mappings
}

const inspectRevenueCatCatalogEntries = (
  entries: ReadonlyArray<TextFileEntry>,
  rootDir: string,
): LocalRevenueCatCatalogInspection => {
  const matchedConfigPaths: Array<string> = []
  const parseErrors: Array<string> = []
  const offeringIds: Array<string> = []
  const packages: Array<LocalRevenueCatPackageMapping> = []

  for (const entry of entries) {
    const parsed = parseJsonDocument(entry.text)

    if (!parsed.ok) {
      parseErrors.push(`${rel(rootDir, entry.path)}: ${parsed.error}`)
      continue
    }

    const offeringNodes = findValuesForKey(parsed.value, "offerings")

    if (offeringNodes.length === 0) {
      continue
    }

    matchedConfigPaths.push(rel(rootDir, entry.path))

    for (const node of offeringNodes) {
      if (Array.isArray(node)) {
        node.forEach((offeringValue, index) => {
          if (!isRecord(offeringValue)) {
            return
          }

          const offeringId = [offeringValue.identifier, offeringValue.offeringId, offeringValue.id]
            .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)
            ?? `offering-${index + 1}`

          offeringIds.push(offeringId)
          packages.push(...extractPackageMappings(
            offeringValue.packages ?? offeringValue.availablePackages,
            offeringId,
            rel(rootDir, entry.path),
          ))
        })
        continue
      }

      if (!isRecord(node)) {
        continue
      }

      for (const [offeringId, offeringValue] of Object.entries(node)) {
        offeringIds.push(offeringId)

        const offeringRecord = isRecord(offeringValue) ? offeringValue : { packages: offeringValue }

        packages.push(...extractPackageMappings(
          offeringRecord.packages ?? offeringRecord.availablePackages,
          offeringId,
          rel(rootDir, entry.path),
        ))
      }
    }
  }

  return {
    configPaths: entries.map((entry) => rel(rootDir, entry.path)),
    matchedConfigPaths: unique(matchedConfigPaths),
    parseErrors,
    offeringIds: unique(offeringIds),
    packages,
  }
}

const inspectStoreKitCatalogEntries = (
  entries: ReadonlyArray<TextFileEntry>,
  rootDir: string,
): StoreKitCatalogInspection => {
  const productIds: Array<string> = []
  const parseErrors: Array<string> = []

  for (const entry of entries) {
    const parsed = parseJsonDocument(entry.text)

    if (!parsed.ok) {
      parseErrors.push(`${rel(rootDir, entry.path)}: ${parsed.error}`)
      continue
    }

    productIds.push(...collectFieldStrings(parsed.value, storeKitProductFieldNames, looksLikeProductId))
  }

  return {
    productIds: unique(productIds),
    parseErrors,
  }
}

const makeCheck = (args: {
  readonly key: string
  readonly source: CommerceCheck["source"]
  readonly boundary: CommerceCheck["boundary"]
  readonly verification: CommerceCheck["verification"]
  readonly verdict: CommerceCheck["verdict"]
  readonly summary: string
  readonly details?: ReadonlyArray<string>
  readonly stub?: boolean
}): CommerceCheck => ({
  key: args.key,
  source: args.source,
  boundary: args.boundary,
  verification: args.verification,
  verdict: args.verdict,
  stub: args.stub ?? false,
  summary: args.summary,
  details: [...(args.details ?? [])],
})

const bundleIdPattern = /PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;]+);/g

const extractBundleIds = (entries: ReadonlyArray<TextFileEntry>): Array<string> => {
  const bundleIds: Array<string> = []

  for (const entry of entries) {
    for (const match of entry.text.matchAll(bundleIdPattern)) {
      const value = match[1]?.trim()

      if (value) {
        bundleIds.push(value)
      }
    }
  }

  return unique(bundleIds)
}

const inAppPurchaseEnabledPattern = /com\.apple\.InAppPurchase\s*=\s*\{[\s\S]*?enabled\s*=\s*1;/m
const inAppPurchaseDisabledPattern = /com\.apple\.InAppPurchase\s*=\s*\{[\s\S]*?enabled\s*=\s*0;/m

const inspectProjectFiles = async (rootDir: string) => {
  const iosRoot = join(rootDir, "ios")
  const rootEntries = await readdir(rootDir, { withFileTypes: true })
  const envPaths = rootEntries
    .filter((entry) => entry.isFile() && entry.name.startsWith(".env"))
    .map((entry) => join(rootDir, entry.name))
    .sort()

  if (!(await fileExists(iosRoot))) {
    return {
      projectPaths: [] as Array<string>,
      projectEntries: [] as Array<TextFileEntry>,
      plistPaths: [] as Array<string>,
      plistEntries: [] as Array<TextFileEntry>,
      xcconfigPaths: [] as Array<string>,
      xcconfigEntries: [] as Array<TextFileEntry>,
      storekitPaths: [] as Array<string>,
      buildInspectionPaths: [] as Array<string>,
      buildInspectionEntries: [] as Array<TextFileEntry>,
      envPaths,
      envEntries: await readTextEntries(envPaths),
    }
  }

  const [
    projectPaths,
    plistPaths,
    xcconfigPaths,
    storekitPaths,
  ] = await Promise.all([
    walkDirectory(iosRoot, (_path, name) => name === "project.pbxproj"),
    walkDirectory(iosRoot, (_path, name) => name === "Info.plist"),
    walkDirectory(iosRoot, (_path, name) => name.endsWith(".xcconfig")),
    walkDirectory(iosRoot, (_path, name) => name.endsWith(".storekit")),
  ])

  const buildInspectionRoots = [join(rootDir, "build"), join(rootDir, "ios", "build")]
  const existingBuildRoots = [] as Array<string>

  for (const candidate of buildInspectionRoots) {
    if (await fileExists(candidate)) {
      existingBuildRoots.push(candidate)
    }
  }

  const buildInspectionPaths = unique((
    await Promise.all(existingBuildRoots.map((path) =>
      walkDirectory(path, (_absolutePath, name) =>
        name === "Info.plist"
        || name === "archived-expanded-entitlements.xcent"
        || name === "embedded.mobileprovision",
      ),
    )))
      .flat()
      .sort())

  const [projectEntries, plistEntries, xcconfigEntries, envEntries, buildInspectionEntries] = await Promise.all([
    readTextEntries(projectPaths),
    readTextEntries(plistPaths),
    readTextEntries(xcconfigPaths),
    readTextEntries(envPaths),
    readTextEntries(buildInspectionPaths),
  ])

  return {
    projectPaths,
    projectEntries,
    plistPaths,
    plistEntries,
    xcconfigPaths,
    xcconfigEntries,
    storekitPaths,
    buildInspectionPaths,
    buildInspectionEntries,
    envPaths,
    envEntries,
  }
}

const invalidCommercePlan = (reason: string) =>
  new UserInputError({
    code: "commerce-plan-invalid",
    reason,
    nextStep: "Fix the commerce plan JSON and retry the command.",
    details: [],
  })

const formatThrownError = (error: unknown): string =>
  isProbeError(error)
    ? formatProbeError(error)
    : error instanceof Error
      ? error.message
      : String(error)

const flowResultToStepVerdict = (flow: SessionFlowResult): CommerceValidationStepResult["verdict"] =>
  flow.verdict === "passed" ? "verified" : "blocked"

const buildStepDetails = (flow: SessionFlowResult): Array<string> => [
  `flow verdict: ${flow.verdict}`,
  `flow retries: ${flow.retries}`,
  ...(flow.failedStep ? [`failed flow step ${flow.failedStep.index}: ${flow.failedStep.summary}`] : []),
]

const getCommerceStepBoundary = (kind: CommerceValidationStepResult["kind"]): CommerceValidationStepResult["boundary"] => {
  switch (kind) {
    case "commerce.assertOfferingsLoaded":
      return "revenuecat-catalog"
    case "commerce.loadProducts":
    case "commerce.assertProductVisible":
    case "commerce.clearTransactions":
    case "commerce.forceFailure":
    case "commerce.expireSubscription":
    case "commerce.disableAutoRenew":
    case "commerce.setTimeRate":
      return "apple-storekit"
    case "commerce.openPaywall":
      return "app-binary"
    default:
      return "runtime-environment"
  }
}

const buildRevenueCatStepNotes = (kind: CommerceValidationStepResult["kind"]): Array<string> => {
  switch (kind) {
    case "commerce.assertOfferingsLoaded":
      return [
        "RevenueCat boundary: offerings loading proves catalog resolution in-app, but does not prove Apple products are fetchable.",
      ]
    case "commerce.loadProducts":
    case "commerce.assertProductVisible":
      return [
        "Apple boundary: product visibility and pricing are separate from RevenueCat offering resolution.",
        revenueCatAppleBoundaryDetail,
      ]
    case "commerce.purchase":
      return [
        "Purchase boundary: a successful purchase path must still end with CustomerInfo showing the expected entitlement.",
      ]
    case "commerce.restore":
      return [
        "Restore boundary: restorePurchases() should recover access for an existing subscriber instead of trusting local cache alone.",
      ]
    case "commerce.assertEntitlement":
      return [
        "Entitlement truth should come from RevenueCat CustomerInfo, not from UI-only local state.",
      ]
    case "commerce.relaunchApp":
      return [
        "Relaunch should re-check CustomerInfo so Probe can distinguish persisted entitlements from stale cached UI state.",
      ]
    default:
      return []
  }
}

export type CommerceServiceError =
  | ArtifactNotFoundError
  | ChildProcessError
  | DaemonNotRunningError
  | EnvironmentError
  | ProtocolMismatchError
  | SessionConflictError
  | SessionNotFoundError
  | UnsupportedCapabilityError
  | UserInputError

export class CommerceService extends Context.Tag("@probe/CommerceService")<
  CommerceService,
  {
    readonly doctor: (params: {
      readonly bundleId: string
      readonly rootDir?: string
      readonly mode?: CommerceValidationMode | null
      readonly provider?: CommerceProvider | null
      readonly storekitConfigPath?: string | null
    }) => Effect.Effect<CommerceDoctorReport, CommerceServiceError>
    readonly validate: (params: {
      readonly sessionId: string
      readonly mode: CommerceValidationMode
      readonly provider?: CommerceProvider | null
      readonly plan?: CommerceValidationPlan | null
    }) => Effect.Effect<CommerceValidationReport, CommerceServiceError>
  }
>() {}

export const CommerceServiceLive = Layer.effect(
  CommerceService,
  Effect.gen(function* () {
    const artifactStore = yield* ArtifactStore
    const daemonClient = yield* DaemonClient

    return CommerceService.of({
      doctor: ({ bundleId, rootDir, mode, provider, storekitConfigPath }) =>
        Effect.tryPromise({
          try: async () => {
            const workspaceRoot = rootDir ?? process.cwd()
            const inspected = await inspectProjectFiles(workspaceRoot)
            const checks: Array<CommerceCheck> = []

            const resolvedStoreKitConfigPath = storekitConfigPath
              ? (isAbsolute(storekitConfigPath) ? storekitConfigPath : resolve(workspaceRoot, storekitConfigPath))
              : null
            const requestedLocalStoreKitCheck = mode === "local-storekit" || resolvedStoreKitConfigPath !== null
            const requestedStoreKitExists = resolvedStoreKitConfigPath !== null
              ? await fileExists(resolvedStoreKitConfigPath)
              : false

            const discoveredBundleIds = extractBundleIds(inspected.projectEntries)
            const exactBundleMatch = discoveredBundleIds.includes(bundleId)
            const nearBundleMatches = discoveredBundleIds.filter((candidate) =>
              candidate !== bundleId && candidate.trim().toLowerCase() === bundleId.trim().toLowerCase(),
            )

            if (inspected.projectEntries.length === 0) {
              checks.push(makeCheck({
                key: "workspace.bundle-id",
                source: "workspace",
                boundary: "app-binary",
                verification: "structurally-verified",
                verdict: "unknown",
                summary: "Probe could not find a checked-in Xcode project to inspect for the requested bundle id.",
                details: ["Expected an iOS project under ./ios so Probe could inspect PRODUCT_BUNDLE_IDENTIFIER settings."],
              }))
            } else if (exactBundleMatch) {
              checks.push(makeCheck({
                key: "workspace.bundle-id",
                source: "workspace",
                boundary: "app-binary",
                verification: "structurally-verified",
                verdict: "verified",
                summary: `The requested bundle id ${bundleId} exactly matches the checked-in Xcode project settings.`,
                details: inspected.projectPaths.map((path) => rel(workspaceRoot, path)),
              }))
            } else if (nearBundleMatches.length > 0) {
              checks.push(makeCheck({
                key: "workspace.bundle-id",
                source: "workspace",
                boundary: "app-binary",
                verification: "structurally-verified",
                verdict: "blocked",
                summary: `The requested bundle id ${bundleId} only matches after case or whitespace normalization.`,
                details: [
                  `near matches: ${nearBundleMatches.join(", ")}`,
                  "Bundle identifiers must match Apple-side configuration exactly, including case and whitespace.",
                ],
              }))
            } else {
              checks.push(makeCheck({
                key: "workspace.bundle-id",
                source: "workspace",
                boundary: "app-binary",
                verification: "structurally-verified",
                verdict: "blocked",
                summary: `The requested bundle id ${bundleId} was not found in checked-in Xcode project settings.`,
                details: discoveredBundleIds.length > 0
                  ? [`discovered bundle ids: ${discoveredBundleIds.join(", ")}`]
                  : ["No PRODUCT_BUNDLE_IDENTIFIER entries were found in the checked-in project files."],
              }))
            }

            checks.push(
              exactBundleMatch
                ? makeCheck({
                    key: "app-store-connect.bundle-id-match",
                    source: "app-store-connect",
                    boundary: "apple-storekit",
                    verification: "externally-gated",
                    verdict: "unknown",
                    stub: true,
                    summary: "Probe verified the local bundle id, but App Store Connect bundle-id comparison is not wired yet.",
                    details: [appStoreConnectStubDetail],
                  })
                : makeCheck({
                    key: "app-store-connect.bundle-id-match",
                    source: "app-store-connect",
                    boundary: "apple-storekit",
                    verification: "externally-gated",
                    verdict: "blocked",
                    summary: "Probe already found a local bundle-id mismatch, so App Store Connect cannot be trusted to match yet.",
                    details: [
                      "Fix the checked-in PRODUCT_BUNDLE_IDENTIFIER mismatch first.",
                      appStoreConnectStubDetail,
                    ],
                  }),
            )

            const enabledCapabilityPaths = inspected.projectEntries
              .filter((entry) => inAppPurchaseEnabledPattern.test(entry.text))
              .map((entry) => rel(workspaceRoot, entry.path))
            const disabledCapabilityPaths = inspected.projectEntries
              .filter((entry) => inAppPurchaseDisabledPattern.test(entry.text))
              .map((entry) => rel(workspaceRoot, entry.path))

            if (enabledCapabilityPaths.length > 0) {
              checks.push(makeCheck({
                key: "workspace.in-app-purchase-capability",
                source: "workspace",
                boundary: "app-binary",
                verification: "structurally-verified",
                verdict: "verified",
                summary: "Probe found an enabled In-App Purchase capability marker in the checked-in Xcode project.",
                details: enabledCapabilityPaths,
              }))
            } else if (disabledCapabilityPaths.length > 0) {
              checks.push(makeCheck({
                key: "workspace.in-app-purchase-capability",
                source: "workspace",
                boundary: "app-binary",
                verification: "structurally-verified",
                verdict: "blocked",
                summary: "The checked-in Xcode project contains a disabled In-App Purchase capability marker.",
                details: disabledCapabilityPaths,
              }))
            } else if (inspected.projectEntries.length > 0) {
              checks.push(makeCheck({
                key: "workspace.in-app-purchase-capability",
                source: "workspace",
                boundary: "app-binary",
                verification: "structurally-verified",
                verdict: "blocked",
                summary: "Probe did not find a common In-App Purchase capability marker in the checked-in Xcode project.",
                details: [
                  "Expected TargetAttributes/SystemCapabilities with com.apple.InAppPurchase enabled = 1 in project.pbxproj.",
                ],
              }))
            } else {
              checks.push(makeCheck({
                key: "workspace.in-app-purchase-capability",
                source: "workspace",
                boundary: "app-binary",
                verification: "structurally-verified",
                verdict: "unknown",
                summary: "Probe could not inspect In-App Purchase capability markers because no checked-in project was found.",
                details: [],
              }))
            }

            if (inspected.buildInspectionEntries.length === 0) {
              checks.push(makeCheck({
                key: "workspace.storekit-capability",
                source: "storekit",
                boundary: "app-binary",
                verification: "structurally-verified",
                verdict: "unknown",
                summary: "No local build artifacts were available for StoreKit-related binary inspection.",
                details: ["Build inspection currently looks under ./build and ./ios/build for plist/entitlement artifacts."],
              }))
            } else {
              const storekitBinaryMarkers = inspected.buildInspectionEntries
                .filter((entry) => /StoreKit|InAppPurchase|com\.apple\.InAppPurchase/i.test(entry.text))
                .map((entry) => rel(workspaceRoot, entry.path))

              checks.push(storekitBinaryMarkers.length > 0
                ? makeCheck({
                    key: "workspace.storekit-capability",
                    source: "storekit",
                    boundary: "app-binary",
                    verification: "structurally-verified",
                    verdict: "verified",
                    summary: "Probe found StoreKit-related markers in inspectable local build artifacts.",
                    details: storekitBinaryMarkers,
                  })
                : makeCheck({
                    key: "workspace.storekit-capability",
                    source: "storekit",
                    boundary: "app-binary",
                    verification: "structurally-verified",
                    verdict: "unknown",
                    summary: "Local build artifacts were present, but Probe did not find stable StoreKit markers to assert against.",
                    details: inspected.buildInspectionPaths.map((path) => rel(workspaceRoot, path)),
                  }))
            }

            if (resolvedStoreKitConfigPath !== null) {
              checks.push(requestedStoreKitExists
                ? makeCheck({
                    key: "workspace.storekit-config",
                    source: "storekit",
                    boundary: "apple-storekit",
                    verification: "structurally-verified",
                    verdict: "verified",
                    summary: "The requested .storekit configuration file exists.",
                    details: [rel(workspaceRoot, resolvedStoreKitConfigPath)],
                  })
                : makeCheck({
                    key: "workspace.storekit-config",
                    source: "storekit",
                    boundary: "apple-storekit",
                    verification: "structurally-verified",
                    verdict: "blocked",
                    summary: "The requested .storekit configuration file was not found.",
                    details: [
                      `requested path: ${rel(workspaceRoot, resolvedStoreKitConfigPath)}`,
                      ...(inspected.storekitPaths.length > 0
                        ? [`available configs: ${inspected.storekitPaths.map((path) => rel(workspaceRoot, path)).join(", ")}`]
                        : []),
                    ],
                  }))
            } else if (requestedLocalStoreKitCheck) {
              checks.push(inspected.storekitPaths.length > 0
                ? makeCheck({
                    key: "workspace.storekit-config",
                    source: "storekit",
                    boundary: "apple-storekit",
                    verification: "structurally-verified",
                    verdict: "verified",
                    summary: "Probe found checked-in .storekit configuration files for local StoreKit validation.",
                    details: inspected.storekitPaths.map((path) => rel(workspaceRoot, path)),
                  })
                : makeCheck({
                    key: "workspace.storekit-config",
                    source: "storekit",
                    boundary: "apple-storekit",
                    verification: "structurally-verified",
                    verdict: "blocked",
                    summary: "Local StoreKit mode was requested, but Probe could not find any checked-in .storekit configuration files.",
                    details: ["Add a .storekit file or pass --config <path> so Probe can point to the intended local StoreKit catalog."],
                  }))
            } else {
              checks.push(inspected.storekitPaths.length > 0
                ? makeCheck({
                    key: "workspace.storekit-config",
                    source: "storekit",
                    boundary: "apple-storekit",
                    verification: "structurally-verified",
                    verdict: "configured",
                    summary: "Probe found checked-in .storekit configuration files that can back local StoreKit testing.",
                    details: inspected.storekitPaths.map((path) => rel(workspaceRoot, path)),
                  })
                : makeCheck({
                    key: "workspace.storekit-config",
                    source: "storekit",
                    boundary: "apple-storekit",
                    verification: "structurally-verified",
                    verdict: "unknown",
                    summary: "No .storekit configuration files were found, but local StoreKit mode was not explicitly requested.",
                    details: [],
                  }))
            }

            const buildFlavorHints = unique([
              ...inspected.envEntries.flatMap((entry) =>
                entry.text
                  .split(/\r?\n/)
                  .filter((line) => /(API|BACKEND|BASE_URL|FLAVOR|ENV(?:IRONMENT)?|STAGING|PRODUCTION|SANDBOX|REVENUECAT|STOREKIT)/i.test(line))
                  .map((line) => `${rel(workspaceRoot, entry.path)}: ${line.trim()}`),
              ),
              ...inspected.xcconfigEntries.flatMap((entry) =>
                entry.text
                  .split(/\r?\n/)
                  .filter((line) => /(API|BACKEND|BASE_URL|FLAVOR|ENV(?:IRONMENT)?|STAGING|PRODUCTION|SANDBOX|REVENUECAT|STOREKIT)/i.test(line))
                  .map((line) => `${rel(workspaceRoot, entry.path)}: ${line.trim()}`),
              ),
              ...inspected.plistEntries.flatMap((entry) =>
                entry.text
                  .split(/\r?\n/)
                  .filter((line) => /(API|BACKEND|BASE_URL|FLAVOR|ENV(?:IRONMENT)?|STAGING|PRODUCTION|SANDBOX|REVENUECAT|STOREKIT)/i.test(line))
                  .map((line) => `${rel(workspaceRoot, entry.path)}: ${line.trim()}`),
              ),
            ]).slice(0, 8)

            checks.push(buildFlavorHints.length > 0
              ? makeCheck({
                  key: "workspace.build-flavor",
                  source: "workspace",
                  boundary: "app-binary",
                  verification: "structurally-verified",
                  verdict: "configured",
                  summary: "Probe found inspectable build-flavor or backend configuration hints in checked-in config files.",
                  details: [
                    ...buildFlavorHints,
                    "Probe does not yet know the app-specific expected backend target, so this remains a structural check only.",
                  ],
                })
              : makeCheck({
                  key: "workspace.build-flavor",
                  source: "workspace",
                  boundary: "app-binary",
                  verification: "structurally-verified",
                  verdict: "unknown",
                  summary: "Probe did not find obvious checked-in build-flavor or backend markers to assert against.",
                  details: ["Add explicit flavor/backend config files if you want Probe to verify environment routing structurally."],
                }))

            checks.push(makeCheck({
              key: "app-store-connect.paid-applications-agreement",
              source: "app-store-connect",
              boundary: "apple-storekit",
              verification: "externally-gated",
              verdict: "unknown",
              stub: true,
              summary: "Paid Applications Agreement status is not wired into Probe yet.",
              details: [
                appStoreConnectStubDetail,
                "Until that lands, verify Agreements, Tax, and Banking directly in App Store Connect before trusting empty product fetches.",
              ],
            }))

            checks.push(makeCheck({
              key: "app-store-connect.first-submission-gate",
              source: "app-store-connect",
              boundary: "apple-storekit",
              verification: "externally-gated",
              verdict: "unknown",
              stub: true,
              summary: "The first-submission gate is modeled, but Apple-side subscription review status is not wired into Probe yet.",
              details: [
                appStoreConnectStubDetail,
                firstSubmissionGateAction,
              ],
            }))

            if (provider === "revenuecat") {
              const revenueCatWorkspace = await inspectRevenueCatWorkspaceFiles(workspaceRoot)
              const revenueCatEntries = [
                ...inspected.envEntries,
                ...inspected.xcconfigEntries,
                ...inspected.plistEntries,
                ...revenueCatWorkspace.configEntries,
              ]
              const publicKeyMatches = collectRevenueCatPublicKeyMatches(revenueCatEntries, workspaceRoot)
              const applePublicKeys = publicKeyMatches.filter((match) => match.value.startsWith("appl_"))
              const testPublicKeys = publicKeyMatches.filter((match) => match.value.startsWith("test_"))

              checks.push(
                applePublicKeys.length > 0
                  ? makeCheck({
                      key: "workspace.revenuecat-sdk-key",
                      source: "workspace",
                      boundary: "app-binary",
                      verification: "structurally-verified",
                      verdict: "configured",
                      summary: "Probe found RevenueCat Apple public SDK key material in local config files.",
                      details: [
                        ...applePublicKeys.map((match) => `apple key: ${match.location}`),
                        ...(testPublicKeys.length > 0
                          ? ["Test Store keys also exist locally. Make sure release builds resolve to appl_ keys instead of test_ keys."]
                          : []),
                      ],
                    })
                  : testPublicKeys.length > 0
                    ? makeCheck({
                        key: "workspace.revenuecat-sdk-key",
                        source: "workspace",
                        boundary: "app-binary",
                        verification: "structurally-verified",
                        verdict: "blocked",
                        summary: "Probe found only RevenueCat Test Store public SDK keys in local config files.",
                        details: [
                          ...testPublicKeys.map((match) => `test key: ${match.location}`),
                          "Release Apple builds must use an appl_ public SDK key, not a test_ Test Store key.",
                        ],
                      })
                    : makeCheck({
                        key: "workspace.revenuecat-sdk-key",
                        source: "workspace",
                        boundary: "app-binary",
                        verification: "structurally-verified",
                        verdict: "unknown",
                        summary: "Probe did not find RevenueCat public SDK key material in inspectable local config files.",
                        details: revenueCatWorkspace.configPaths.length > 0
                          ? [
                              `inspectable RevenueCat config files: ${revenueCatWorkspace.configPaths.map((path) => rel(workspaceRoot, path)).join(", ")}`,
                              "If the app configures Purchases in source code instead of checked-in config files, verify that the iOS key starts with appl_.",
                            ]
                          : ["Add a checked-in config hint (for example .env, xcconfig, plist, or revenuecat JSON) if you want Probe to verify the SDK key structurally."],
                      }),
              )

              const localCatalog = inspectRevenueCatCatalogEntries(revenueCatWorkspace.configEntries, workspaceRoot)
              const storeKitEntries = requestedStoreKitExists && resolvedStoreKitConfigPath !== null
                ? await readTextEntries([resolvedStoreKitConfigPath])
                : await readTextEntries(inspected.storekitPaths)
              const storeKitCatalog = inspectStoreKitCatalogEntries(storeKitEntries, workspaceRoot)
              const packagesWithoutProducts = localCatalog.packages.filter((pkg) => pkg.productIds.length === 0)
              const packagesWithDuplicateProducts = localCatalog.packages.filter((pkg) => pkg.productIds.length > 1)
              const packagesWithEntitlements = localCatalog.packages.filter((pkg) => pkg.entitlements.length > 0)
              const packagesMissingEntitlements = localCatalog.packages.filter((pkg) => pkg.entitlements.length === 0)
              const mappedProductIds = unique(localCatalog.packages.flatMap((pkg) => pkg.productIds))
              const missingStoreKitProducts = mappedProductIds.filter((productId) => !storeKitCatalog.productIds.includes(productId))
              const parseErrorDetails = localCatalog.parseErrors.slice(0, 3)
              const storeKitParseErrorDetails = storeKitCatalog.parseErrors.slice(0, 3)
              const defaultOfferingPresent = localCatalog.offeringIds.includes("default")
              const offeringsMissingPackages = localCatalog.offeringIds.filter((offeringId) =>
                !localCatalog.packages.some((pkg) => pkg.offeringId === offeringId),
              )
              const localOfferingDiscoveryDetails = localCatalog.matchedConfigPaths.length > 0
                ? [`checked files: ${localCatalog.matchedConfigPaths.join(", ")}`]
                : localCatalog.configPaths.length > 0
                  ? [`candidate files: ${localCatalog.configPaths.join(", ")}`]
                  : ["No checked-in revenuecat/offering/paywall JSON files were found."]
              const storeKitComparisonSourceDetails = requestedStoreKitExists && resolvedStoreKitConfigPath !== null
                ? [`requested config: ${rel(workspaceRoot, resolvedStoreKitConfigPath)}`]
                : inspected.storekitPaths.length > 0
                  ? [`discovered configs: ${inspected.storekitPaths.map((path) => rel(workspaceRoot, path)).join(", ")}`]
                  : ["No checked-in .storekit configuration file was available for comparison."]

              checks.push(
                localCatalog.offeringIds.length === 0
                  ? makeCheck({
                      key: "workspace.revenuecat-offerings",
                      source: "workspace",
                      boundary: "revenuecat-catalog",
                      verification: "structurally-verified",
                      verdict: "unknown",
                      summary: "Probe could not find a parseable local RevenueCat offerings structure to inspect.",
                      details: [
                        ...localOfferingDiscoveryDetails,
                        ...parseErrorDetails,
                        "Probe can only perform structural offerings checks from local config. Dashboard offering resolution still needs manual or API-backed verification.",
                      ],
                    })
                  : offeringsMissingPackages.length > 0
                    ? makeCheck({
                        key: "workspace.revenuecat-offerings",
                        source: "workspace",
                        boundary: "revenuecat-catalog",
                        verification: "structurally-verified",
                        verdict: "blocked",
                        summary: "Probe found RevenueCat offering definitions locally, but at least one offering has no packages attached.",
                        details: [
                          `offerings without packages: ${offeringsMissingPackages.join(", ")}`,
                          ...localCatalog.matchedConfigPaths.map((path) => `source: ${path}`),
                          ...parseErrorDetails,
                        ],
                      })
                    : makeCheck({
                        key: "workspace.revenuecat-offerings",
                        source: "workspace",
                        boundary: "revenuecat-catalog",
                        verification: "structurally-verified",
                        verdict: "configured",
                        summary: "Probe found a local RevenueCat offerings structure with attached packages.",
                        details: [
                          `offerings: ${localCatalog.offeringIds.join(", ")}`,
                          defaultOfferingPresent
                            ? "default offering is encoded locally."
                            : "default offering is not encoded locally; confirm it in the RevenueCat dashboard if the app expects it.",
                          ...localCatalog.matchedConfigPaths.map((path) => `source: ${path}`),
                          ...parseErrorDetails,
                        ],
                      }),
              )

              checks.push(
                localCatalog.packages.length === 0
                  ? makeCheck({
                      key: "workspace.revenuecat-package-product-mapping",
                      source: "workspace",
                      boundary: "revenuecat-catalog",
                      verification: "structurally-verified",
                      verdict: "unknown",
                      summary: "Probe could not inspect package-to-product mappings from local RevenueCat config files.",
                      details: [
                        "Add checked-in RevenueCat package config if you want Probe to validate package mappings locally.",
                        ...parseErrorDetails,
                      ],
                    })
                  : packagesWithoutProducts.length > 0 || packagesWithDuplicateProducts.length > 0
                    ? makeCheck({
                        key: "workspace.revenuecat-package-product-mapping",
                        source: "workspace",
                        boundary: "revenuecat-catalog",
                        verification: "structurally-verified",
                        verdict: "blocked",
                        summary: "Probe found a local RevenueCat package mapping that is empty or maps to multiple product ids.",
                        details: [
                          ...packagesWithoutProducts.map((pkg) => `${pkg.sourcePath}: ${pkg.offeringId}/${pkg.packageId} has no productId.`),
                          ...packagesWithDuplicateProducts.map((pkg) => `${pkg.sourcePath}: ${pkg.offeringId}/${pkg.packageId} maps to ${pkg.productIds.join(", ")}. Remove duplicate or stale Test Store products.`),
                        ],
                      })
                    : makeCheck({
                        key: "workspace.revenuecat-package-product-mapping",
                        source: "workspace",
                        boundary: "revenuecat-catalog",
                        verification: "structurally-verified",
                        verdict: "configured",
                        summary: "Probe found locally-declared RevenueCat packages that each map to exactly one product id.",
                        details: localCatalog.packages.map((pkg) => `${pkg.sourcePath}: ${pkg.offeringId}/${pkg.packageId} -> ${pkg.productIds[0]}`),
                      }),
              )

              checks.push(
                localCatalog.packages.length === 0
                  ? makeCheck({
                      key: "workspace.revenuecat-entitlement-mapping",
                      source: "workspace",
                      boundary: "revenuecat-catalog",
                      verification: "structurally-verified",
                      verdict: "unknown",
                      summary: "Probe could not inspect local RevenueCat entitlement mapping because no package config was found.",
                      details: [],
                    })
                  : packagesWithEntitlements.length === 0
                    ? makeCheck({
                        key: "workspace.revenuecat-entitlement-mapping",
                        source: "workspace",
                        boundary: "revenuecat-catalog",
                        verification: "structurally-verified",
                        verdict: "unknown",
                        summary: "Probe found local RevenueCat package config, but it did not encode entitlement attachments.",
                        details: [
                          "Verify product-to-entitlement attachments directly in the RevenueCat dashboard.",
                          ...parseErrorDetails,
                        ],
                      })
                    : packagesMissingEntitlements.length > 0
                      ? makeCheck({
                          key: "workspace.revenuecat-entitlement-mapping",
                          source: "workspace",
                          boundary: "revenuecat-catalog",
                          verification: "structurally-verified",
                          verdict: "blocked",
                          summary: "Probe found local RevenueCat package config with missing entitlement attachments.",
                          details: packagesMissingEntitlements.map((pkg) => `${pkg.sourcePath}: ${pkg.offeringId}/${pkg.packageId} has no entitlement mapping.`),
                        })
                      : makeCheck({
                          key: "workspace.revenuecat-entitlement-mapping",
                          source: "workspace",
                          boundary: "revenuecat-catalog",
                          verification: "structurally-verified",
                          verdict: "configured",
                          summary: "Probe found locally-declared RevenueCat packages with entitlement attachments.",
                          details: packagesWithEntitlements.map((pkg) => `${pkg.sourcePath}: ${pkg.offeringId}/${pkg.packageId} -> ${pkg.entitlements.join(", ")}`),
                        }),
              )

              checks.push(
                mappedProductIds.length === 0
                  ? makeCheck({
                      key: "storekit.revenuecat-product-consistency",
                      source: "storekit",
                      boundary: "apple-storekit",
                      verification: "structurally-verified",
                      verdict: "unknown",
                      summary: "Probe could not compare RevenueCat package ids to local StoreKit products because no local product mapping was found.",
                      details: [],
                    })
                  : storeKitEntries.length === 0 || storeKitCatalog.productIds.length === 0
                    ? makeCheck({
                        key: "storekit.revenuecat-product-consistency",
                        source: "storekit",
                        boundary: "apple-storekit",
                        verification: "structurally-verified",
                        verdict: "unknown",
                        summary: "Probe could not compare RevenueCat product ids against a parseable local .storekit catalog.",
                        details: [
                          ...storeKitComparisonSourceDetails,
                          ...storeKitParseErrorDetails,
                        ],
                      })
                    : missingStoreKitProducts.length > 0
                      ? makeCheck({
                          key: "storekit.revenuecat-product-consistency",
                          source: "storekit",
                          boundary: "apple-storekit",
                          verification: "structurally-verified",
                          verdict: "blocked",
                          summary: "Probe found RevenueCat product ids locally that do not exist in the inspected .storekit catalog.",
                          details: [
                            `missing from .storekit: ${missingStoreKitProducts.join(", ")}`,
                            `storekit products: ${storeKitCatalog.productIds.join(", ")}`,
                            ...storeKitParseErrorDetails,
                          ],
                        })
                      : makeCheck({
                          key: "storekit.revenuecat-product-consistency",
                          source: "storekit",
                          boundary: "apple-storekit",
                          verification: "structurally-verified",
                          verdict: "configured",
                          summary: "Probe found local RevenueCat product ids in the inspected .storekit catalog.",
                          details: [
                            `mapped products: ${mappedProductIds.join(", ")}`,
                            ...storeKitParseErrorDetails,
                          ],
                        }),
              )

              checks.push(
                makeCheck({
                  key: "revenuecat.offering-resolves",
                  source: "revenuecat",
                  boundary: "revenuecat-catalog",
                  verification: "externally-gated",
                  verdict: "unknown",
                  stub: true,
                  summary: "RevenueCat dashboard offering resolution still requires external verification.",
                  details: [
                    "Probe cannot call RevenueCat dashboard APIs from this CLI lane without credentials.",
                    "Open RevenueCat → Offerings and confirm the expected offering exists and each package is attached.",
                    revenueCatAppleBoundaryDetail,
                  ],
                }),
                makeCheck({
                  key: "apple.storekit-products-fetchable",
                  source: "app-store-connect",
                  boundary: "apple-storekit",
                  verification: "externally-gated",
                  verdict: "unknown",
                  stub: true,
                  summary: "Apple StoreKit product fetchability remains a separate boundary from RevenueCat catalog resolution.",
                  details: [
                    appStoreConnectStubDetail,
                    revenueCatAppleBoundaryDetail,
                    "After RevenueCat catalog checks pass, verify product fetchability in Apple sandbox/TestFlight and inspect agreement, metadata, and first-submission state before blaming RevenueCat.",
                  ],
                }),
                makeCheck({
                  key: "revenuecat.package-product-mapping",
                  source: "revenuecat",
                  boundary: "revenuecat-catalog",
                  verification: "externally-gated",
                  verdict: "unknown",
                  stub: true,
                  summary: "RevenueCat dashboard package-to-product mapping still requires external verification.",
                  details: [
                    "Open RevenueCat → Products / Offerings and confirm each iOS package maps to exactly one Apple product.",
                    "Remove stale Test Store or duplicate product mappings from any affected package.",
                  ],
                }),
                makeCheck({
                  key: "revenuecat.entitlement-mapping",
                  source: "revenuecat",
                  boundary: "revenuecat-catalog",
                  verification: "externally-gated",
                  verdict: "unknown",
                  stub: true,
                  summary: "RevenueCat dashboard entitlement mapping still requires external verification.",
                  details: [
                    "Open RevenueCat → Entitlements and confirm the expected Apple products are attached to the correct entitlement(s).",
                    "If local config omits entitlement hints, treat the dashboard as the source of truth.",
                  ],
                }),
                makeCheck({
                  key: "revenuecat.apple-iap-key",
                  source: "revenuecat",
                  boundary: "revenuecat-catalog",
                  verification: "externally-gated",
                  verdict: "unknown",
                  stub: true,
                  summary: "RevenueCat Apple In-App Purchase key status still requires dashboard verification.",
                  details: [
                    "Open RevenueCat project settings and confirm the Apple In-App Purchase Key is configured for the App Store connection.",
                    "A missing key can leave RevenueCat catalog healthy while Apple products remain unavailable.",
                  ],
                }),
                makeCheck({
                  key: "revenuecat.store-connection",
                  source: "revenuecat",
                  boundary: "revenuecat-catalog",
                  verification: "externally-gated",
                  verdict: "unknown",
                  stub: true,
                  summary: "RevenueCat store-connection health still requires dashboard verification.",
                  details: [
                    "Open RevenueCat project settings and confirm the App Store store connection is active.",
                    "If the store connection is inactive, dashboard offerings may look valid while Apple-backed purchase attempts still fail.",
                  ],
                }),
              )
            }

            const warnings: Array<string> = []
            const stubbedChecks = checks.filter((check) => check.stub)

            if (mode === "local-storekit") {
              warnings.push("Local StoreKit preflight is helpful for fast smoke tests, but it is not authoritative for Apple-backed commerce behavior.")
            }

            if (provider === "revenuecat") {
              warnings.push(revenueCatAppleBoundaryDetail)
            }

            if (stubbedChecks.length > 0) {
              warnings.push(`${stubbedChecks.length} external Apple/RevenueCat check${stubbedChecks.length === 1 ? " is" : "s are"} currently stubbed and reported as unknown.`)
            }

            const report = buildCommerceDoctorReport({
              workspaceRoot,
              bundleId,
              mode: mode ?? null,
              provider: provider ?? null,
              checks,
              warnings,
            })

            return {
              ...report,
              summary: `${report.summary} Overall verdict: ${report.verdict}.`,
            }
          },
          catch: (error) =>
            new EnvironmentError({
              code: "commerce-doctor-workspace",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Inspect the workspace paths and retry `probe doctor commerce`.",
              details: [],
            }),
        }),

      validate: ({ sessionId, mode, provider, plan }) =>
        Effect.gen(function* () {
          if (plan !== null && plan !== undefined) {
            const validationError = validateCommerceValidationPlan(plan)

            if (validationError !== null) {
              return yield* invalidCommercePlan(validationError)
            }
          }

          const session = yield* daemonClient.getSessionHealth({ sessionId })
          const environment = buildCommerceEnvironmentReport({
            mode,
            session,
          })

          const warnings: Array<string> = []

          if (!environment.authoritative) {
            warnings.push("Probe is reporting a non-authoritative commerce environment; treat passing results as structural smoke, not final Apple-backed proof.")
          }

          if (provider === "revenuecat") {
            warnings.push(revenueCatValidationSequence)
            warnings.push(revenueCatNegativeCaseCoverage)
            warnings.push(revenueCatAppleBoundaryDetail)
          }

          const executedSteps: Array<CommerceValidationStepResult> = []
          const planSteps = plan?.steps ?? []

          for (const [index, step] of planSteps.entries()) {
            if (mode !== "local-storekit") {
              executedSteps.push({
                index: index + 1,
                kind: step.kind,
                boundary: getCommerceStepBoundary(step.kind),
                verdict: "unknown",
                stub: true,
                summary: `${step.kind} is stubbed for ${mode} mode until Apple-backed commerce execution lands.`,
                details: [
                  "This command currently reports environment authority honestly and writes a durable report artifact.",
                  ...(provider === "revenuecat"
                    ? [
                        ...buildRevenueCatStepNotes(step.kind),
                        "Sandbox/TestFlight validation still needs a real-device RevenueCat lane before Probe can verify this directly.",
                      ]
                    : []),
                ],
                warnings: [],
                flowResult: null,
              })
              continue
            }

            if (!isCommerceExecutableStep(step)) {
              executedSteps.push({
                index: index + 1,
                kind: step.kind,
                boundary: getCommerceStepBoundary(step.kind),
                verdict: "unknown",
                stub: true,
                summary: `${step.kind} is defined in the commerce contract, but local StoreKit control injection is not implemented yet.`,
                details: ["The contract exists now so future StoreKit control wiring can land without changing the plan shape."],
                warnings: [],
                flowResult: null,
              })
              continue
            }

            const flowAttempt = yield* Effect.either(daemonClient.runSessionFlow({
              sessionId,
              flow: step.flow,
            }))

            if (flowAttempt._tag === "Left") {
              const stepResult: CommerceValidationStepResult = {
                index: index + 1,
                kind: step.kind,
                boundary: getCommerceStepBoundary(step.kind),
                verdict: "blocked",
                stub: false,
                summary: `${step.kind} failed before Probe could complete the underlying session flow.`,
                details: [
                  formatThrownError(flowAttempt.left),
                  ...(provider === "revenuecat" ? buildRevenueCatStepNotes(step.kind) : []),
                ],
                warnings: [],
                flowResult: null,
              }
              executedSteps.push(stepResult)

              if (step.continueOnError !== true) {
                break
              }

              continue
            }

            const flowResult = flowAttempt.right
            const stepResult: CommerceValidationStepResult = {
              index: index + 1,
              kind: step.kind,
              boundary: getCommerceStepBoundary(step.kind),
              verdict: flowResultToStepVerdict(flowResult),
              stub: false,
              summary: `${step.kind} completed with ${flowResult.verdict}.`,
              details: [
                ...buildStepDetails(flowResult),
                ...(provider === "revenuecat" ? buildRevenueCatStepNotes(step.kind) : []),
              ],
              warnings: [...flowResult.warnings],
              flowResult,
            }
            executedSteps.push(stepResult)

            if (stepResult.verdict === "blocked" && step.continueOnError !== true) {
              break
            }
          }

          if (provider === "revenuecat" && planSteps.length > 0) {
            executedSteps.push(
              {
                index: executedSteps.length + 1,
                kind: "commerce.assertCancellationLeavesEntitlementInactive",
                boundary: "runtime-environment",
                verdict: "unknown",
                stub: true,
                summary: "Purchase cancellation coverage is defined, but Probe cannot yet drive a cancellable native purchase interaction automatically.",
                details: [
                  "Expected result: cancelling the purchase flow must leave CustomerInfo entitlement state inactive.",
                  "Manual or future purchase-sheet control coverage is still required here.",
                ],
                warnings: [],
                flowResult: null,
              },
              {
                index: executedSteps.length + 2,
                kind: "commerce.assertSinglePurchaseInFlight",
                boundary: "runtime-environment",
                verdict: "unknown",
                stub: true,
                summary: "Double-tap purchase protection is defined, but Probe cannot yet assert concurrent purchase suppression automatically.",
                details: [
                  "Expected result: only one purchase operation should enter flight while the CTA is disabled.",
                  "Manual or future UI instrumentation coverage is still required here.",
                ],
                warnings: [],
                flowResult: null,
              },
            )
          }

          const reportWithoutArtifact = buildCommerceValidationReport({
            sessionId,
            mode,
            provider: provider ?? null,
            plan: plan ?? null,
            environment,
            executedSteps,
            warnings,
            reportArtifact: null,
          })

          const reportArtifact = yield* artifactStore.writeDerivedOutput({
            sessionId,
            label: "commerce-report",
            format: "json",
            content: `${JSON.stringify(reportWithoutArtifact, null, 2)}\n`,
            summary: `Commerce validation report (${mode})`,
          })

          const finalReport = buildCommerceValidationReport({
            sessionId,
            mode,
            provider: provider ?? null,
            plan: plan ?? null,
            environment,
            executedSteps,
            warnings,
            reportArtifact,
          })

          const stubCount = executedSteps.filter((step) => step.stub).length
          const verdictCounts = rollupCommerceVerdict(executedSteps.map((step) => step.verdict))

          return {
            ...finalReport,
            summary: `${finalReport.summary} Overall verdict: ${finalReport.verdict}. Raw step rollup: ${verdictCounts}.${stubCount > 0 ? ` Stubbed steps: ${stubCount}.` : ""}`,
          }
        }),
    })
  }),
)

export type { ArtifactRecord }
