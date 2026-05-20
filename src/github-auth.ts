import { execFile } from "node:child_process";

const GH_AUTH_TOKEN_TIMEOUT_MS = 10_000;

function getRequiredEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function getGitHubAuthToken(): Promise<string> {
  const envToken = getRequiredEnv("GH_TOKEN") ?? getRequiredEnv("GITHUB_TOKEN");
  if (envToken) {
    return Promise.resolve(envToken);
  }

  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      ["auth", "token"],
      {
        encoding: "utf8",
        timeout: GH_AUTH_TOKEN_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }

        const token = stdout.trim();
        if (!token) {
          reject(new Error("gh auth token returned an empty token"));
          return;
        }

        resolve(token);
      },
    );
  });
}
