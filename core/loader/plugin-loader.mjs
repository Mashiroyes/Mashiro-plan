import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN_DIRECTORY_PATTERN = /^mashirobot-plugin-[a-z0-9][a-z0-9-]*$/;
const RESERVED_EXACT_COMMANDS = new Set(["help", "/help", "帮助"]);
const REQUIRED_EXPORTS = ["match", "handle", "healthCheck", "getHelp"];

class PluginValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PluginValidationError";
    this.code = code;
  }
}

function createRegistry() {
  return {
    plugins: [],
    byMenuIndex: new Map(),
    byExactCommand: new Map(),
    failures: [],
  };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateManifest(manifest, directoryName, pluginDirectory) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new PluginValidationError("INVALID_MANIFEST", "plugin.json must contain one JSON object");
  }
  if (manifest.schemaVersion !== 1) {
    throw new PluginValidationError("INVALID_MANIFEST", "schemaVersion must equal 1");
  }
  if (!isNonEmptyString(manifest.id)) {
    throw new PluginValidationError("INVALID_MANIFEST", "id must be a non-empty string");
  }
  if (manifest.id !== directoryName) {
    throw new PluginValidationError(
      "DIRECTORY_ID_MISMATCH",
      `manifest id ${manifest.id} does not match directory ${directoryName}`,
    );
  }
  for (const field of ["name", "version", "description"]) {
    if (!isNonEmptyString(manifest[field])) {
      throw new PluginValidationError("INVALID_MANIFEST", `${field} must be a non-empty string`);
    }
  }
  if (!Number.isInteger(manifest.menuIndex) || manifest.menuIndex <= 0) {
    throw new PluginValidationError("INVALID_MANIFEST", "menuIndex must be a positive integer");
  }
  if (typeof manifest.priority !== "number" || !Number.isFinite(manifest.priority)) {
    throw new PluginValidationError("INVALID_MANIFEST", "priority must be a finite number");
  }
  if (typeof manifest.enabled !== "boolean") {
    throw new PluginValidationError("INVALID_MANIFEST", "enabled must be a boolean");
  }
  if (!isNonEmptyString(manifest.entry) || path.isAbsolute(manifest.entry)) {
    throw new PluginValidationError("INVALID_MANIFEST", "entry must be a non-empty relative path");
  }
  if (!Array.isArray(manifest.exactCommands)) {
    throw new PluginValidationError("INVALID_MANIFEST", "exactCommands must be an array of strings");
  }

  const commandSet = new Set();
  for (const command of manifest.exactCommands) {
    if (!isNonEmptyString(command) || command !== command.trim()) {
      throw new PluginValidationError(
        "INVALID_MANIFEST",
        "exactCommands must contain non-empty, already-trimmed strings",
      );
    }
    if (RESERVED_EXACT_COMMANDS.has(command)) {
      throw new PluginValidationError("RESERVED_EXACT_COMMAND", `${command} is a global reserved command`);
    }
    if (commandSet.has(command)) {
      throw new PluginValidationError("INVALID_MANIFEST", `duplicate exact command inside manifest: ${command}`);
    }
    commandSet.add(command);
  }

  const entryPath = path.resolve(pluginDirectory, manifest.entry);
  const relativeEntry = path.relative(pluginDirectory, entryPath);
  if (relativeEntry === ".." || relativeEntry.startsWith(`..${path.sep}`) || path.isAbsolute(relativeEntry)) {
    throw new PluginValidationError("ENTRY_PATH_TRAVERSAL", "entry must remain inside the plugin directory");
  }

  return {
    ...manifest,
    exactCommands: [...manifest.exactCommands],
    entryPath,
  };
}

async function ensurePluginFiles(pluginDirectory, manifest) {
  try {
    const readme = await stat(path.join(pluginDirectory, "README.md"));
    if (!readme.isFile()) throw new Error("README.md is not a file");
  } catch (error) {
    throw new PluginValidationError("MISSING_PLUGIN_README", `README.md is required: ${error.message}`);
  }

  try {
    const entry = await stat(manifest.entryPath);
    if (!entry.isFile()) throw new Error("entry is not a file");
    await access(manifest.entryPath);
    const [realPluginDirectory, realEntryPath] = await Promise.all([
      realpath(pluginDirectory),
      realpath(manifest.entryPath),
    ]);
    const realRelativeEntry = path.relative(realPluginDirectory, realEntryPath);
    if (
      realRelativeEntry === ".." ||
      realRelativeEntry.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelativeEntry)
    ) {
      throw new PluginValidationError(
        "ENTRY_PATH_TRAVERSAL",
        "entry symlink must remain inside the plugin directory",
      );
    }
  } catch (error) {
    if (error.code === "ENTRY_PATH_TRAVERSAL") throw error;
    throw new PluginValidationError("PLUGIN_ENTRY_LOAD_ERROR", `plugin entry is unavailable: ${error.message}`);
  }
}

function validatePluginModule(moduleNamespace) {
  for (const exportName of REQUIRED_EXPORTS) {
    const exported = moduleNamespace[exportName];
    if (typeof exported !== "function") {
      throw new PluginValidationError("INVALID_PLUGIN_MODULE", `entry must export ${exportName}()`);
    }
  }
}

function emitLog(logger, payload) {
  if (!logger) return;
  try {
    if (typeof logger === "function") {
      Promise.resolve(logger(payload)).catch(() => {});
      return;
    }
    const method = logger[payload.level] ?? logger.log;
    if (typeof method === "function") {
      Promise.resolve(method.call(logger, payload)).catch(() => {});
    }
  } catch {
    // A logging failure must not make plugin discovery unavailable.
  }
}

function addFailure(registry, logger, candidate, code, message, details = {}) {
  const failure = {
    code,
    pluginId: candidate?.manifest?.id ?? candidate?.directoryName ?? "unknown",
    directory: candidate?.pluginDirectory ?? "",
    message: String(message),
    ...details,
  };
  registry.failures.push(failure);
  emitLog(logger, {
    level: "error",
    pluginId: failure.pluginId,
    event: "plugin_load_failed",
    message: `${failure.code}: ${failure.message}`,
  });
}

function compareCandidates(left, right) {
  const priorityDifference = right.manifest.priority - left.manifest.priority;
  if (priorityDifference !== 0) return priorityDifference;
  return left.manifest.id.localeCompare(right.manifest.id, "en");
}

/**
 * Discover direct mashirobot-plugin-* children once at process startup.
 */
export async function loadPlugins({ pluginRoot, logger }) {
  const registry = createRegistry();
  let directoryEntries;

  try {
    directoryEntries = await readdir(pluginRoot, { withFileTypes: true });
  } catch (error) {
    addFailure(
      registry,
      logger,
      { directoryName: "plugin-root", pluginDirectory: path.resolve(pluginRoot) },
      "PLUGIN_ROOT_READ_ERROR",
      error.message,
    );
    return registry;
  }

  const candidates = [];
  const pluginDirectories = directoryEntries
    .filter((entry) => entry.isDirectory() && PLUGIN_DIRECTORY_PATTERN.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));

  for (const directoryEntry of pluginDirectories) {
    const pluginDirectory = path.resolve(pluginRoot, directoryEntry.name);
    const candidate = { directoryName: directoryEntry.name, pluginDirectory };
    try {
      const manifestText = await readFile(path.join(pluginDirectory, "plugin.json"), "utf8");
      let rawManifest;
      try {
        rawManifest = JSON.parse(manifestText.replace(/^\uFEFF/, ""));
      } catch (error) {
        throw new PluginValidationError("INVALID_MANIFEST", `plugin.json is not valid JSON: ${error.message}`);
      }
      candidate.manifest = validateManifest(rawManifest, directoryEntry.name, pluginDirectory);
      await ensurePluginFiles(pluginDirectory, candidate.manifest);

      if (!candidate.manifest.enabled) {
        emitLog(logger, {
          level: "info",
          pluginId: candidate.manifest.id,
          event: "plugin_disabled",
          message: "plugin is disabled by manifest",
        });
        continue;
      }
      candidates.push(candidate);
    } catch (error) {
      addFailure(
        registry,
        logger,
        candidate,
        error.code || "PLUGIN_MANIFEST_READ_ERROR",
        error.message,
      );
    }
  }

  candidates.sort(compareCandidates);

  for (const candidate of candidates) {
    const existingMenuPlugin = registry.byMenuIndex.get(candidate.manifest.menuIndex);
    if (existingMenuPlugin) {
      addFailure(
        registry,
        logger,
        candidate,
        "DUPLICATE_MENU_INDEX",
        `menuIndex ${candidate.manifest.menuIndex} is already used by ${existingMenuPlugin.manifest.id}`,
        { conflictingPluginId: existingMenuPlugin.manifest.id, menuIndex: candidate.manifest.menuIndex },
      );
      continue;
    }

    const conflictingCommand = candidate.manifest.exactCommands.find((command) =>
      registry.byExactCommand.has(command),
    );
    if (conflictingCommand) {
      const existingCommandPlugin = registry.byExactCommand.get(conflictingCommand);
      addFailure(
        registry,
        logger,
        candidate,
        "DUPLICATE_EXACT_COMMAND",
        `exact command ${conflictingCommand} is already used by ${existingCommandPlugin.manifest.id}`,
        { conflictingPluginId: existingCommandPlugin.manifest.id, exactCommand: conflictingCommand },
      );
      continue;
    }

    let moduleNamespace;
    try {
      moduleNamespace = await import(pathToFileURL(candidate.manifest.entryPath).href);
      validatePluginModule(moduleNamespace);
    } catch (error) {
      addFailure(
        registry,
        logger,
        candidate,
        error.code === "INVALID_PLUGIN_MODULE" ? error.code : "PLUGIN_ENTRY_LOAD_ERROR",
        error.message,
      );
      continue;
    }

    const loadedPlugin = {
      manifest: Object.freeze({
        schemaVersion: candidate.manifest.schemaVersion,
        id: candidate.manifest.id,
        name: candidate.manifest.name,
        version: candidate.manifest.version,
        description: candidate.manifest.description,
        hideDescription: candidate.manifest.hideDescription === true,
        menuIndex: candidate.manifest.menuIndex,
        priority: candidate.manifest.priority,
        enabled: candidate.manifest.enabled,
        entry: candidate.manifest.entry,
        exactCommands: Object.freeze([...candidate.manifest.exactCommands]),
      }),
      module: moduleNamespace,
      directory: candidate.pluginDirectory,
      entryPath: candidate.manifest.entryPath,
    };

    registry.plugins.push(loadedPlugin);
    registry.byMenuIndex.set(loadedPlugin.manifest.menuIndex, loadedPlugin);
    for (const command of loadedPlugin.manifest.exactCommands) {
      registry.byExactCommand.set(command, loadedPlugin);
    }
    emitLog(logger, {
      level: "info",
      pluginId: loadedPlugin.manifest.id,
      event: "plugin_loaded",
      message: `loaded ${loadedPlugin.manifest.version}`,
    });
  }

  return registry;
}
