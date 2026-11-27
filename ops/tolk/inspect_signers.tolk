// Public-address inspection only. No send, signing, or private-key access.
import "@stdlib/strings"
import "@acton/env"
import "@acton/io"
import "@acton/fmt"
import "@acton/emulation/scripts"

fun inspectRole(envName: string, role: string) {
    val name = env<string>(envName);
    if (name != null && name!.calculateLength() > 0) {
        val wallet = scripts.wallet(name!);
        println("SIGNER_{} = {}", role, wallet.address);
    }
}

fun main() {
    inspectRole("A9_INSPECT_deployer", "deployer");
    inspectRole("A9_INSPECT_treasury", "treasury");
    inspectRole("A9_INSPECT_keeper", "keeper");
    inspectRole("A9_INSPECT_roundOpener", "roundOpener");
    inspectRole("A9_INSPECT_teamWallet", "teamWallet");
    inspectRole("A9_INSPECT_presaleHotWallet", "presaleHotWallet");
    inspectRole("A9_INSPECT_promoHotWallet", "promoHotWallet");
    println("A9_SIGNERS_READ_ONLY_OK");
}
