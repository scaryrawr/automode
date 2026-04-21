import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { xdgConfig } from "xdg-basedir";
import z from "zod";

const CONFIG_DIR = xdgConfig ? join(xdgConfig, "copilot") : join(homedir(), ".copilot");

const CONFIG_FILE = join(CONFIG_DIR, "automode.json");

const ConfigSchema = z.object({
  autoMode: z.boolean().default(false),
});

type Configuration = z.infer<typeof ConfigSchema>;

/**
 * Reads the persisted config file and normalizes it with schema defaults.
 *
 * If the file is missing or cannot be parsed, the default configuration is
 * returned instead.
 */
const parseConfig = async (): Promise<Configuration> => {
  try {
    const content = await readFile(CONFIG_FILE, "utf-8");
    return ConfigSchema.parse(JSON.parse(content));
  } catch {
    return ConfigSchema.parse({});
  }
};

/**
 * Persists the current configuration snapshot to disk as formatted JSON.
 *
 * @param config The normalized configuration values to save.
 */
const writeConfig = async (config: Configuration): Promise<void> => {
  return writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
};

/**
 * Ensures the config directory exists and loads the current configuration.
 *
 * The returned object exposes property accessors backed by an in-memory state
 * object. Assigning to a property updates that state immediately and kicks off
 * an asynchronous write so future sessions see the new value.
 *
 * @returns A configuration object with getters and setters for each config value.
 */
export const loadConfig = async (): Promise<Configuration> => {
  await mkdir(CONFIG_DIR, { recursive: true });
  const state = await parseConfig();
  let pendingWrite: Promise<void> = Promise.resolve();

  const persistSnapshot = (config: Configuration): void => {
    // Serialize writes so rapid toggles persist each snapshot in setter order.
    pendingWrite = pendingWrite.then(
      () => writeConfig(config),
      () => writeConfig(config),
    );
    void pendingWrite.catch(() => {
      // TODO: logging
    });
  };

  return {
    get autoMode() {
      return state.autoMode;
    },
    set autoMode(value: boolean) {
      state.autoMode = value;
      const snapshot: Configuration = { ...state };
      persistSnapshot(snapshot);
    },
  };
};
