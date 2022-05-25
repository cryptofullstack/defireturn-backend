const curveArr = require("./data/vfat_tools/curve.json");
const { writeToFile } = require("./utils");

const obj = {};

for (const i in curveArr) {
  const item = curveArr[i];
  item.protocol = item.protocol.toLowerCase();
  obj[item.lp_address.id.toLowerCase()] = item;
}

writeToFile("data/vfat_tools/curve_map.json", obj);
