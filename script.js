/*
 * NiMH Battery Tester Dashboard
 * Data schema matches final_code.ino:
 * batteryConnected, voltage, current_mA, power_mW, soc, remaining_mAh,
 * discharged_mAh, totalDischarged_mAh, cycleCount, D, C,
 * dischargePulses, timestamp.
 */
const FIREBASE_URL = "https://bms1-62947-default-rtdb.asia-southeast1.firebasedatabase.app/BMS/live.json";
const POLL_MS = 2000;
const MAX_POINTS = 1500;
const $ = id => document.getElementById(id);
const readings = [];
const charts = {};
let busy = false;
let toastTimer;

const palette = {
  text: "#91a2b8", grid: "rgba(124,145,169,.15)",
  green: "#40d6a5", cyan: "#55c8e8", violet: "#a78bfa",
  amber: "#f5b65f", red: "#ef858b"
};
const commonOptions = {
  responsive: true, maintainAspectRatio: false, animation: false,
  interaction: { mode: "index", intersect: false },
  plugins: {
    legend: { labels: { color: palette.text, usePointStyle: true, boxWidth: 7, boxHeight: 7, padding: 16, font: { family: "DM Sans", size: 9 } } },
    tooltip: { backgroundColor: "#07111e", borderColor: "#344960", borderWidth: 1, titleColor: "#edf4fc", bodyColor: "#c5d2e1", padding: 10, titleFont: { family: "DM Sans" }, bodyFont: { family: "DM Sans", size: 10 } }
  },
  scales: {
    x: { ticks: { color: palette.text, maxTicksLimit: 8, font: { family: "DM Sans", size: 8 } }, grid: { color: palette.grid }, border: { display: false } },
    y: { beginAtZero: true, ticks: { color: palette.text, font: { family: "DM Sans", size: 8 } }, grid: { color: palette.grid }, border: { display: false } }
  }
};
function gradient(ctx, color) {
  const g = ctx.createLinearGradient(0, 0, 0, 240);
  g.addColorStop(0, color.replace(")", ",.22)").replace("rgb", "rgba"));
  g.addColorStop(1, color.replace(")", ",0)").replace("rgb", "rgba"));
  return g;
}
function lineDataset(label, data, color, fill=false, yAxisID="y") {
  return { label, data, yAxisID, borderColor: color, backgroundColor: fill ? color + "20" : color,
    borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: .28, fill,
    spanGaps: true };
}
function makeLine(id, datasets, extra={}) {
  const ctx = $(id).getContext("2d");
  const opts = structuredClone(commonOptions);
  if (extra.rightAxis) {
    opts.scales.y1 = { position:"right", beginAtZero:true, grid:{drawOnChartArea:false,color:palette.grid}, ticks:{color:palette.text,font:{size:8}}, border:{display:false} };
  }
  if (extra.yMax !== undefined) opts.scales.y.max = extra.yMax;
  charts[id] = new Chart(ctx, { type:"line", data:{labels:[],datasets}, options:{...opts,...extra.options} });
}
function initCharts() {
  makeLine("vc", [
    lineDataset("Voltage (V)", [], palette.cyan, false, "y"),
    lineDataset("Current (A)", [], palette.violet, false, "y1")
  ], {rightAxis:true});
  makeLine("v", [lineDataset("Voltage (V)", [], palette.cyan, true)]);
  makeLine("i", [lineDataset("Current (A)", [], palette.violet, true)]);
  makeLine("s", [lineDataset("SOC (%)", [], palette.green, true)], {yMax:100});
  makeLine("r", [lineDataset("Remaining capacity (mAh)", [], palette.amber, true)], {yMax:2000});
  charts.sr = new Chart($("sr"), {
    type:"scatter",
    data:{datasets:[{label:"SOC vs Remaining capacity",data:[],backgroundColor:palette.green,borderColor:palette.green,pointRadius:3,pointHoverRadius:5}]},
    options:{...structuredClone(commonOptions),scales:{
      x:{title:{display:true,text:"Remaining capacity (mAh)",color:palette.text,font:{size:9}},ticks:{color:palette.text,font:{size:8}},grid:{color:palette.grid}},
      y:{title:{display:true,text:"State of charge (%)",color:palette.text,font:{size:9}},min:0,max:100,ticks:{color:palette.text,font:{size:8}},grid:{color:palette.grid}}
    }}
  });
}
function fmt(value, digits=2) {
  const n=Number(value); return Number.isFinite(n) ? n.toFixed(digits) : "--";
}
function setConnection(online, label) {
  $("connectionPill").classList.toggle("offline",!online);
  $("connection").textContent=label;
}
function showToast(message) {
  const el=$("toast"); el.textContent=message; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove("show"),2600);
}
function updateCards(d) {
  const soc=Math.max(0,Math.min(100,Number(d.soc)||0));
  const remaining=Math.max(0,Number(d.remaining_mAh)||0);
  const connected=Boolean(d.batteryConnected);
  $("voltage").textContent=fmt(d.voltage,2);
  $("current").textContent=fmt((Number(d.current_mA)||0)/1000,3);
  $("power").textContent=fmt((Number(d.power_mW)||0)/1000,3);
  $("soc").textContent=fmt(soc,1);
  $("remaining").textContent=fmt(remaining,1);
  $("discharged").textContent=fmt(d.discharged_mAh,1);
  $("socBar").style.width=soc+"%";
  $("dischargePulses").textContent=Number(d.dischargePulses||0).toLocaleString();
  $("totalDischarged").innerHTML=fmt(d.totalDischarged_mAh,1)+" <em>mAh</em>";
  $("cycleCount").textContent=(d.cycleCount===undefined||d.cycleCount===null||d.cycleCount==="" )?"--":Number(d.cycleCount).toLocaleString(undefined,{minimumFractionDigits:0,maximumFractionDigits:3});
  $("dStatus").textContent=Number(d.D)||0;
  $("cStatus").textContent=Number(d.C)||0;
  $("batteryBanner").classList.toggle("connected",connected);
  $("batteryBanner").classList.toggle("disconnected",!connected);
  $("batteryStatus").textContent=connected?"BATTERY CONNECTED":"BATTERY DISCONNECTED";
  $("batteryMessage").textContent=connected?"Battery detected · Live parameters are being monitored":"Battery removed or below detection threshold";
  $("statusText").textContent=connected?"Battery detected":"No battery detected";
  // Relay and low-voltage cut-off status from the ESP32-S3 firmware.
  const relayOn = d.relayOn === true || d.relayOn === 1 || d.relayOn === "true";
  const cutoffActive = d.lowVoltageCutoff === true || d.lowVoltageCutoff === 1 || d.lowVoltageCutoff === "true";
  const relayKnown = d.relayOn !== undefined && d.relayOn !== null;
  const cutoffKnown = d.lowVoltageCutoff !== undefined && d.lowVoltageCutoff !== null;

  $("relayStatus").textContent = relayKnown ? (relayOn ? "ON" : "OFF") : "--";
  $("relayStatePill").textContent = relayKnown ? (relayOn ? "ENERGISED" : "DE-ENERGISED") : "WAITING";
  $("relayCard").classList.toggle("relay-safe", relayKnown && relayOn);
  $("relayCard").classList.toggle("relay-off", relayKnown && !relayOn);
  $("relayDescription").textContent = !relayKnown ? "Waiting for relay data from ESP32-S3." :
    (relayOn ? "Relay is energised and the load path is enabled." : "Relay output is OFF. The load path is disconnected.");

  $("loadStatus").textContent = relayKnown ? (relayOn ? "CONNECTED" : "DISCONNECTED") : "--";
  $("loadStatePill").textContent = relayKnown ? (relayOn ? "LOAD ENABLED" : "LOAD ISOLATED") : "WAITING";
  $("loadCard").classList.toggle("relay-safe", relayKnown && relayOn);
  $("loadCard").classList.toggle("relay-off", relayKnown && !relayOn);
  $("loadDescription").textContent = !relayKnown ? "Waiting for relay data from ESP32-S3." :
    (relayOn ? "Battery power is available to the connected load." : "No battery power is supplied to the load.");

  $("protectionStatus").textContent = cutoffKnown ? (cutoffActive ? "ACTIVE" : "NORMAL") : "--";
  $("protectionStatePill").textContent = cutoffKnown ? (cutoffActive ? "CUTOFF LATCHED" : "MONITORING") : "WAITING";
  $("protectionCard").classList.toggle("relay-warning", cutoffKnown && cutoffActive);
  $("protectionCard").classList.toggle("relay-safe", cutoffKnown && !cutoffActive);
  $("protectionDescription").textContent = !cutoffKnown ? "Waiting for protection data from ESP32-S3." :
    (cutoffActive ? "Low battery voltage detected. Load disconnected by the relay." : "Battery voltage protection is monitoring the pack.");

  const note = $("relayNote");
  note.classList.toggle("warning", cutoffKnown && cutoffActive);
  note.innerHTML = cutoffKnown && cutoffActive
    ? '<span class="relay-note-icon">!</span><span><b>LOW-VOLTAGE CUT-OFF ACTIVE</b> — The firmware has latched the protection and disconnected the load. Disconnect and reconnect the battery to reset the latch.</span>'
    : (relayKnown && relayOn
      ? '<span class="relay-note-icon">✓</span><span>Protection is normal. The relay is ON and the load is connected.</span>'
      : '<span class="relay-note-icon">i</span><span>Relay and protection status are received directly from the ESP32-S3 through Firebase.</span>');

  $("updated").textContent=new Date().toLocaleTimeString();
}
function pushReading(d) {
  const now=new Date();
  readings.push({
    time:now, label:now.toLocaleTimeString(),
    voltage:Number(d.voltage)||0,
    current:(Number(d.current_mA)||0)/1000,
    power:(Number(d.power_mW)||0)/1000,
    soc:Number(d.soc)||0,
    remaining:Number(d.remaining_mAh)||0,
    discharged:Number(d.discharged_mAh)||0,
    totalDischarged:Number(d.totalDischarged_mAh)||0,
    cycleCount:Number(d.cycleCount)||0,
    dischargePulses:Number(d.dischargePulses)||0,
    batteryConnected:Boolean(d.batteryConnected),
    relayOn:d.relayOn===true || d.relayOn===1 || d.relayOn==="true",
    lowVoltageCutoff:d.lowVoltageCutoff===true || d.lowVoltageCutoff===1 || d.lowVoltageCutoff==="true"
  });
  if(readings.length>MAX_POINTS) readings.shift();
  $("pointCount").textContent=readings.length.toLocaleString();
  updateCharts();
}
function updateCharts() {
  const labels=readings.map(p=>p.label);
  const values=(key)=>readings.map(p=>p[key]);
  const set=(id,index,data)=>{charts[id].data.labels=labels;charts[id].data.datasets[index].data=data;charts[id].update("none");};
  set("vc",0,values("voltage")); set("vc",1,values("current"));
  set("v",0,values("voltage")); set("i",0,values("current"));
  set("s",0,values("soc")); set("r",0,values("remaining"));
  charts.sr.data.datasets[0].data=readings.map(p=>({x:p.remaining,y:p.soc}));
  charts.sr.update("none");
}
async function fetchLiveData() {
  if(busy)return; busy=true;
  try {
    const response=await fetch(FIREBASE_URL+"?cacheBust="+Date.now(),{cache:"no-store"});
    if(!response.ok)throw new Error("Firebase HTTP "+response.status);
    const data=await response.json();
    if(!data||typeof data!=="object")throw new Error("No live data received");
    updateCards(data);
    // The ESP32 writes a Firebase server timestamp. One sample is recorded per poll.
    pushReading(data);
    setConnection(true,"Firebase connected");
  } catch(err) {
    setConnection(false,"Connection issue");
    console.error("BMS Firebase read failed:",err);
  } finally {busy=false;}
}
function downloadCanvas(id) {
  const chart=charts[id];
  if(!chart){showToast("Graph is not available yet.");return;}
  const link=document.createElement("a");
  link.href=chart.toBase64Image("image/png",1);
  link.download=`nimh-tester-${id}-graph.png`;
  document.body.appendChild(link);link.click();link.remove();
}
async function downloadAllGraphs() {
  if(!window.JSZip){showToast("ZIP library could not load. Download graphs one by one.");return;}
  const zip=new JSZip();
  Object.keys(charts).forEach(id=>zip.file(`nimh-tester-${id}-graph.png`,charts[id].toBase64Image("image/png",1).split(",")[1],{base64:true}));
  zip.file("bms-readings.csv",buildCSV());
  const blob=await zip.generateAsync({type:"blob"});
  const url=URL.createObjectURL(blob);const a=document.createElement("a");
  a.href=url;a.download="nimh-tester-bms-graphs-and-data.zip";a.click();URL.revokeObjectURL(url);
  showToast("All graphs and CSV data downloaded.");
}
function buildCSV() {
  const headers=["Time","Voltage_V","Current_A","Power_W","SOC_percent","Remaining_mAh","Discharged_mAh","TotalDischarged_mAh","CycleCount","DischargePulses","BatteryConnected","RelayOn","LowVoltageCutoff"];
  const rows=readings.map(p=>[p.time.toISOString(),p.voltage,p.current,p.power,p.soc,p.remaining,p.discharged,p.totalDischarged,p.cycleCount,p.dischargePulses,p.batteryConnected,p.relayOn,p.lowVoltageCutoff]);
  return [headers,...rows].map(row=>row.map(v=>`"${String(v).replaceAll('"','""')}"`).join(",")).join("\r\n");
}
function downloadCSV() {
  if(!readings.length){showToast("No readings available to export yet.");return;}
  const blob=new Blob([buildCSV()],{type:"text/csv;charset=utf-8"});
  const url=URL.createObjectURL(blob);const a=document.createElement("a");
  a.href=url;a.download="nimh-tester-bms-readings.csv";a.click();URL.revokeObjectURL(url);
  showToast("Readings CSV downloaded.");
}
function clearHistory() {
  readings.length=0;
  Object.values(charts).forEach(chart=>{
    chart.data.labels=[];
    chart.data.datasets.forEach(ds=>ds.data=[]);
    chart.update();
  });
  $("pointCount").textContent="0";
  showToast("Graph history cleared from this browser session.");
}
document.querySelectorAll(".download-chart").forEach(btn=>btn.addEventListener("click",()=>downloadCanvas(btn.dataset.chart)));
$("downloadAll").addEventListener("click",downloadAllGraphs);
$("downloadCSV").addEventListener("click",downloadCSV);
$("clearHistory").addEventListener("click",clearHistory);
$("refresh").addEventListener("click",fetchLiveData);
initCharts();
fetchLiveData();
setInterval(fetchLiveData,POLL_MS);
