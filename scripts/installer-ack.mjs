const INSTALLER_ACK_PREFIX = "meta-kim installer ack:";

const singleLine = (value) =>
  String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim();

const listField = (values) => {
  const items = (Array.isArray(values) ? values : [values])
    .map(singleLine)
    .filter((item) => item.length > 0);
  return items.length > 0 ? items.join(",") : "none";
};

function installerAckLine({
  mode = "install",
  targets = "config-default",
  skills = [],
  flags = [],
  pid = process.pid,
  cwd = process.cwd(),
  root = "",
} = {}) {
  return [
    INSTALLER_ACK_PREFIX,
    `mode=${singleLine(mode) || "install"}`,
    `targets=${listField(targets)}`,
    `skills=${listField(skills)}`,
    `flags=${listField(flags)}`,
    `pid=${pid}`,
    `cwd=${singleLine(cwd)}`,
    `root=${singleLine(root)}`,
  ].join(" ");
}

function hasInstallerAck(output) {
  return typeof output === "string" && output.includes(INSTALLER_ACK_PREFIX);
}

export { INSTALLER_ACK_PREFIX, hasInstallerAck, installerAckLine };
