const DigestFetch = require("digest-fetch");
const readline = require("readline-sync");
const keys = require("./keys.js");
const hardwareSpec = require("./hardwareSpec.json");
const fs = require("fs");

// Get PUE and CI from https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8224424/
let cloudProviders = fs.readFileSync("./cloudProviders_datacenters.csv").toString().split("\n").map(l => l.split(","));
let ciAggregated = fs.readFileSync("./CI_aggregated.csv").toString().split("\n").map(l => l.split(","));

const BASE_URL = "https://cloud-qa.mongodb.com/api/atlas/v1.0";
const VERBOSE = false;
const METRICS = {
  MEMORY: {
    available: "SYSTEM_MEMORY_AVAILABLE"
  },
  CPU: {
    user: "SYSTEM_NORMALIZED_CPU_USER",
    kernel: "SYSTEM_NORMALIZED_CPU_KERNEL",
    nice: "SYSTEM_NORMALIZED_CPU_NICE",
    iowait: "SYSTEM_NORMALIZED_CPU_IOWAIT",
    irq: "SYSTEM_NORMALIZED_CPU_IRQ",
    softirq: "SYSTEM_NORMALIZED_CPU_SOFTIRQ",
    guest: "SYSTEM_NORMALIZED_CPU_GUEST",
    steal: "SYSTEM_NORMALIZED_CPU_STEAL"
  }
};
const GRANULARITY_PARAMS = {
  granularity: "PT5M",
  period: "P1D",
  runningTimeHours: 24
};

if (VERBOSE) console.log(`Granularity parameters: granularity: ${GRANULARITY_PARAMS.granularity}, period: ${GRANULARITY_PARAMS.period}`)

const getMeasurement = (measurements, metric) => {
  return measurements.measurements.find(m => m.name === metric).dataPoints
}

const getDatapointsAvg = (datapoints) => {
  let values = datapoints.map(d => d.value);
  let total = values.reduce((prev, current) => prev + current, 0);
  let avg = total / datapoints.length;
  return avg;
}

const getMemoryUsage = measurements => {
  let datapoints = getMeasurement(measurements, METRICS.MEMORY.available);
  let average = getDatapointsAvg(datapoints);
  return average;
}

const getCpuUsage = measurements => {
  let metrics = Object.values(METRICS.CPU);
  let totalUsage = 0;
  for (let i = 0; i < metrics.length; i++) {
    let datapoints = getMeasurement(measurements, metrics[i]);
    let average = getDatapointsAvg(datapoints);
    totalUsage += average;
  }
  return totalUsage;
}

async function main() {
  const client = new DigestFetch(
      keys.user,
      keys.key,
      { }
  );

  const fetch = async (url, params = {}) => {
    let p = new URLSearchParams(params);
    let fullUrl = `${BASE_URL}/${url}${p.toString().length ? "?" + p.toString() : ""}`;
    if (VERBOSE) console.info(`Fetching data from ${fullUrl}`);
    let resp = await client.fetch(fullUrl).then(r => r.json());
    let keys = Object.keys(resp);
    if (keys.indexOf("error") > -1) {
      console.error(resp.error);
      return;
    }
    if (VERBOSE) console.info(`Received response. Keys: ${Object.keys(resp)}`);
    let result = keys.indexOf("results") > -1 ? resp.results : resp;
    return result;
  }

  const measureCarbonFootprint = async (cluster, providerName, regionName, groupId) => {

    let PUE = 1.67;
    if (providerName === "GCP") PUE = 1.10;
    if (providerName === "AZURE") PUE = 1.125;
    if (providerName === "AWS") PUE = 1.2;
    if (VERBOSE) console.log(
        `Using a PUE factor ${PUE} for provider ${providerName}`);

    if (VERBOSE) console.log(
        `Trying to find details stats for ${providerName} ${regionName}`)
    let cloudProvider = cloudProviders.find(c => {
      return c[0].toUpperCase() === providerName && c[1].toUpperCase().replace(
          /(_|-| )/g, "") === regionName.replace(/(_|-| )/g, "");
    });

    let gCO2ekWh = 475;
    if (cloudProvider) {
      if (cloudProvider[6] !== "") PUE = parseFloat(cloudProvider[6]);
      let ci = ciAggregated.find(ci => ci[0] === cloudProvider[2]);
      gCO2ekWh = ci ? parseFloat(ci[4]) : 475;
      if (VERBOSE) console.log(
          `Using a carbon intensity of ${gCO2ekWh} gCO2/kWh`);
    } else {
      if (VERBOSE) console.log(
          `No specific CI value found, using default gCO2e/kWh (475)`);
    }

    if (VERBOSE) console.log(`Using carbon intensity ${gCO2ekWh} gCO2e/kWh`);

    console.log(
        `Cluster ${cluster.name} is an instance on ${providerName} (${regionName}). PUE: ${PUE}, gCO2/kWh: ${gCO2ekWh}`);

    let clusterProcesses = cluster.mongoURI.replace("mongodb://", "").split(
        ",");
    clusterProcesses.map(p => {
      let process = {
        id: p,
        cluster: cluster.name,
        providerSettings: cluster.providerSettings,
        diskSizeGb: cluster.diskSizeGB,
        PUE,
        gCO2ekWh
      }
      processes.push(process);
    });

    console.log(
        `Found ${processes.length} processes running on ${clusters.length} clusters`);
    if (processes.length === 0) process.exit();

    let processUsage = await Promise.all(processes.map(async p => {
      if (VERBOSE) console.log(`Calculating measurements for ${p.id}`);
      let measurements = await fetch(
          `groups/${groupId}/processes/${p.id}/measurements`,
          GRANULARITY_PARAMS);
      let memoryUsage = getMemoryUsage(measurements);
      let memoryUsageGb = memoryUsage / 1000000;
      let cpuUsage = getCpuUsage(measurements);
      let hardware = hardwareSpec[p.providerSettings.instanceSizeName][p.providerSettings.providerName];
      let nCpu = hardware.CPU;
      let memoryAvail = hardware.memory;
      let providerName = p.providerSettings.providerName.toUpperCase();

      return {
        processId: p.id,
        clusterName: p.cluster,
        providerName,
        instanceSizeName: p.providerSettings.instanceSizeName,
        region: p.providerSettings.regionName,
        memoryUsageGb,
        cpuUsage,
        diskSizeGb: p.diskSizeGb,
        nCpu,
        memoryAvail,
        PUE: p.PUE,
        gCO2ekWh: p.gCO2ekWh
      }
    }));

    console.log(
        `All data collected from ${processUsage.length} processes. Calculating environmental impact`);
    console.log(
        `Using suggested calculations from "https://onlinelibrary.wiley.com/doi/10.1002/advs.202100707"`);
    //𝐸=𝑡×(𝑛c×𝑃c×𝑢c+𝑛m×𝑃m)×𝑃𝑈𝐸×0.001
    // CPU power usage is an average of https://github.com/GreenAlgorithms/green-algorithms-tool/blob/master/data/TDP_cpu.csv
    // Memory energy consumption used 0.3725 W per GB
    // Storage energy consumption used 0.001 W per GB
    // Average PUE = 1.67
    let energies = processUsage.map(p => {
      console.log(
          `${GRANULARITY_PARAMS.runningTimeHours} * (${p.nCpu} * 12.4 * ${p.cpuUsage
          / 100} + ${p.memoryAvail} * 0.3725 + ${p.diskSizeGb} * 0.001) * ${p.PUE} * 0.001 * ${p.gCO2ekWh};`);
      let energy = GRANULARITY_PARAMS.runningTimeHours * (p.nCpu * 12.4
              * p.cpuUsage / 100 + p.memoryAvail * 0.3725 + p.diskSizeGb * 0.001)
          * p.PUE * 0.001 * p.gCO2ekWh;
      return energy;
    });

    let totalCarbon = energies.reduce((a, b) => a + b);
    let monthlyCarbon = (totalCarbon * 30 / 1000).toFixed(2);
    console.log(`For a singular cluster`);
    console.log(`There is an estimated monthly:`);
    console.log(
        ` 🏭  ${monthlyCarbon} kg of CO2 equivalent`)

    return monthlyCarbon;
  }

  console.log("Fetching groups");
  let groups = await fetch("groups");
  console.log(`Found ${groups.length} groups (projects)`);
  let groupNames = groups.map(g => g.name);

  let groupName = readline.keyInSelect(groupNames, "Which group do you want to use?");
  let group = groups[groupName];

  if (VERBOSE) console.log(`Fetching clusters for group ${group.name}`);
  let clusters = await fetch(`groups/${group.id}/clusters`);

  if (VERBOSE) console.log(`Found ${clusters.length} clusters`);
  let processes = [];

  let totalEnergies = await Promise.all(clusters.map(c => measureCarbonFootprint(c, c.providerSettings.providerName.toUpperCase(), c.providerSettings.regionName.toUpperCase(), group.id)));

  let totalCarbon = totalEnergies.reduce((a, b) => a + b);

  console.log(`For all clusters: there is a monthly equivalent to:`);
  console.log(` 🏭  ${(totalCarbon)} kg of CO2 equivalent`);
}

main();