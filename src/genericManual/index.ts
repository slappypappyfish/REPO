import { AxiosResponse } from "axios";
import { client } from "../api/client";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import parseToC, { ParsedToC } from "./parseToC";
import { Download, Page } from "playwright";
import { Manual } from "..";

export default async function downloadGenericManual(
  page: Page,
  manualData: Manual,
  path: string
) {
  // download ToC
  let tocReq: AxiosResponse;
  try {
    console.log("Downloading table of contents...");
    tocReq = await client({
      method: "GET",
      url: `${manualData.type}/${manualData.id}/toc.xml`,
      // we don't want axios to parse this
      responseType: "text",
    });
  } catch (e: any) {
    if (e.response && e.response.status === 404) {
      throw new Error(
        `Manual ${manualData.id} doesn't appear to exist-- are you sure the ID is right?`
      );
    }

    throw new Error(
      `Unknown error getting title XML for manual ${manualData.raw}: ${e}`
    );
  }

  const files = parseToC(tocReq.data, manualData.year);

  // write to disk
  console.log("Saving table of contents...");
  await Promise.all([
    writeFile(join(path, "toc-full.xml"), tocReq.data),
    writeFile(
      join(path, "toc-downloaded.json"),
      JSON.stringify(files, null, 2)
    ),
    writeFile(
      join(path, "toc.js"),
      `document.toc = JSON.parse(\`${JSON.stringify(files).replaceAll(
        '\\"',
        ""
      )}\`);`
    ),
  ]);

  console.log("Downloading full manual...");
  await recursivelyDownloadManual(page, path, files);
}

async function recursivelyDownloadManual(
  page: Page,
  path: string,
  toc: ParsedToC
) {
  const exploded = Object.entries(toc);
    

  for (const explIdx in exploded) {
    const [name, value] = exploded[explIdx];

    if (typeof value === "string") {
      const sanitizedName = name.replace(/\//g, "-");
      const sanitizedPath = `${join(path, sanitizedName)}.pdf`;
      const url = `https://techinfo.toyota.com${value}`;
      console.log(`Downloading page ${sanitizedName}... (URL: ${url})`);

      // download page
      try {
        // wait for either download or load event, whichever comes first, for some reason headless doesn't trigger load event on PDFs
        const eventPromise = Promise.any([
          page.waitForEvent("load"),
          page.waitForEvent("download"),
        ]);
        // navigate to page
        await page.goto(url, { waitUntil: "commit" });
        const event = await eventPromise;

        // get content url
        const contentUrl = await page.evaluate(() => {
          return document.URL;
        });

        // get content type
        const contentType = await page.evaluate(() => {
          return document.contentType;
        });
        console.log(`URL: ${contentUrl}, type: ${contentType}`);

        // if content url ends in .pdf, load that url and download it (for some reason the first goto doesn't follow the redirects all the way to the PDF)
        if (contentUrl.endsWith(".pdf")) {
          const downloadPromise = page.waitForEvent('download');
          await page.goto(contentUrl, { waitUntil: "commit" });
          const download = await downloadPromise;
          await download.saveAs(sanitizedPath);
        } else {
          await page.addScriptTag({
            content: `document.querySelector(".footer").remove()`,
          });
          await page.pdf({
            path: sanitizedPath,
            margin: {
              top: 1,
              right: 1,
              bottom: 1,
              left: 1,
            },
          });
        }
      } catch (e) {
        console.error(`Error saving page ${name}: ${e}`);
        continue;
      }

      // downloaded page, move on
      continue;
    }

    // we're not at the bottom of the tree, continue

    // create folder
    const newPath = join(path, name.replace(/\//g, "-"));
    if (newPath.includes("undefined")) debugger;
    try {
      await mkdir(newPath, { recursive: true });
    } catch (e) {
      if ((e as any).code === "EEXIST") {
        console.log(
          `Not creating folder ${newPath} because it already exists.`
        );
      }
    }

    await recursivelyDownloadManual(page, newPath, value);
  }
}
