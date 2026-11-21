import config from "./config.ts";
import { getBgVMManagers } from "./vm/utils.ts";
import "./utils/redactError.ts";
import express from "express";
import bodyParser from "body-parser";

// A stray rejection (an interval job, a request path) used to kill the whole
// worker: Node's default for unhandled rejections is to exit. Log it (the
// redactError import below keeps axios request configs out of the print) and
// stay up. Same pattern as server.ts
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

const app = express();
const vmManagers = getBgVMManagers();

app.use(bodyParser.json());

Object.values(vmManagers).forEach((manager) => {
  manager?.runBackgroundJobs();
});

app.post("/assignVM", async (req, res) => {
  try {
    // Find a pool that matches the size and region requirements
    const pools = Object.values(vmManagers).filter((mgr) => {
      return (
        mgr.getIsLarge() === Boolean(req.body.isLarge) &&
        (mgr.getRegion() === req.body.region || !req.body.region)
      );
    });
    let vm = null;
    // Sequentially try each to give earlier pools preference
    // We might want to add the ability to load balance as well by randomly selecting between pools with same priority
    for (let pool of pools) {
      console.log(
        "try assignVM from pool:",
        pool.getPoolName(),
        req.body.roomId,
        req.body.uid,
      );
      vm = await pool.assignVM(req.body.roomId, req.body.uid);
      if (vm) {
        res.json(vm);
        return;
      }
    }
    res.json(null);
  } catch (e) {
    console.warn(e);
    res.status(500).end();
  }
});

app.post("/releaseVM", async (req, res) => {
  // The id reaches provider API URLs and, for Docker, a shell command over SSH
  // (docker rm -fv <id>). Real ids are hex (Docker), numeric (Hetzner, DO) or
  // UUIDs (Scaleway); anything else could inject a command
  if (req.body.id && !/^[A-Za-z0-9-]{1,64}$/.test(String(req.body.id))) {
    res.status(400).end();
    return;
  }
  try {
    const pool =
      vmManagers[
        req.body.provider + (req.body.isLarge ? "Large" : "") + req.body.region
      ];
    if (req.body.id) {
      await pool?.resetVM(req.body.id, req.body.roomId);
    }
    res.end();
  } catch (e) {
    console.warn(e);
    res.status(500).end();
  }
});

app.get("/stats", async (req, res) => {
  const vmManagerStats: AnyDict = {};
  for (let [key, vmManager] of Object.entries(vmManagers)) {
    const availableVBrowsers = await vmManager?.getAvailableVBrowsers();
    const stagingVBrowsers = await vmManager?.getStagingVBrowsers();
    const size = await vmManager?.getCurrentSize();
    if (key && vmManager) {
      vmManagerStats[key] = {
        availableVBrowsers,
        stagingVBrowsers,
        bufferSize: vmManager?.getTargetBuffer(),
        // terminationVBrowsers,
        size,
      };
    }
  }
  res.json(vmManagerStats);
});

app.get("/isFreePoolFull", async (req, res) => {
  const freePools = Object.values(vmManagers).filter((mgr) => {
    return mgr?.getIsLarge() === false && mgr?.getLimitSize() > 0;
  });
  const fullResult = await Promise.all<Boolean>(
    freePools.map(async (freePool) => {
      let isFull = false;
      if (freePool) {
        const availableCount = await freePool.getAvailableCount();
        const limitSize = freePool?.getLimitSize() ?? 0;
        const currentSize = await freePool.getCurrentSize();
        isFull = Boolean(
          limitSize > 0 &&
          (Number(availableCount) === 0 ||
            Number(currentSize) - Number(availableCount) > limitSize * 0.95),
        );
      }
      return isFull;
    }),
  );
  const isFull = freePools.length && fullResult.every(Boolean);
  res.json({ isFull });
});

app.post("/updateSnapshot", async (req, res) => {
  const pool = vmManagers[req.body.provider + req.body.region];
  const result = await pool?.updateSnapshot();
  res.send(result?.toString() + "\n");
});

// No auth on these routes (assign/release VMs, stats): only the room server on
// this machine calls them, via http://localhost. Listening on every interface
// let anyone on the network release another room's VM
app.listen(Number(config.VMWORKER_PORT), "127.0.0.1", () => {
  console.log("vmWorker listening on %s", config.VMWORKER_PORT);
});
