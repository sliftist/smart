import rtl_433 from "unofficial-rtl_433-binaries";
import { execSync } from "child_process";

execSync(`"${rtl_433.getBinary()}" -f 433M -M level -F json -F log`, {
    stdio: "inherit"
});