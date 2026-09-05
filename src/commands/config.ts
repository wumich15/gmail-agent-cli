import { bootstrap } from "../core/bootstrap.js";
import { EXIT_CODES } from "../core/errors.js";
import { configFilePath, databaseFilePath } from "../config/paths.js";

export async function configShow(): Promise<number> {
  const ctx = bootstrap();
  console.log(
    JSON.stringify(
      {
        configPath: configFilePath(),
        databasePath: databaseFilePath(),
        config: ctx.config
      },
      null,
      2
    )
  );
  return EXIT_CODES.ok;
}
