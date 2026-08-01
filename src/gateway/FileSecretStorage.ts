import { chmod, mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { QwenSecretStorage } from "../providers/qwen/QwenAuthManager";

export function gatewayDataDir(): string {
  return path.resolve(
    process.env.QWEN_GATEWAY_DATA_DIR ||
      path.join(os.homedir(), ".qwen-astrbot-gateway"),
  );
}

/** Small chmod-protected store used by the standalone gateway CLI. */
export class FileSecretStorage implements QwenSecretStorage {
  private readonly file: string;

  constructor(root = gatewayDataDir()) {
    this.file = path.join(root, "gateway-secrets.json");
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.read())[key];
  }

  async store(key: string, value: string): Promise<void> {
    const values = await this.read();
    values[key] = value;
    await this.write(values);
  }

  async delete(key: string): Promise<void> {
    const values = await this.read();
    delete values[key];
    await this.write(values);
  }

  private async read(): Promise<Record<string, string>> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, string] =>
          typeof entry[1] === "string",
        ),
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  }

  private async write(values: Record<string, string>): Promise<void> {
    const dir = path.dirname(this.file);
    const temporary = `${this.file}.${process.pid}.tmp`;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, JSON.stringify(values, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.file);
      await chmod(this.file, 0o600).catch(() => undefined);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
