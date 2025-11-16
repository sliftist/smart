import rtl_433 from "unofficial-rtl_433-binaries";
import { execSync } from "child_process";

// -R 12 should prevent picking up other signals? Maybe?
execSync(`"${rtl_433.getBinary()}" -f 433.5M -M level -F json -F log -s 2.4M -R 12`, {
    stdio: "inherit"
});