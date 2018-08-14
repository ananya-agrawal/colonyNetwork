pragma solidity ^0.4.23;
pragma experimental "v0.5.0";

import "../lib/dappsys/roles.sol";


contract ColonyNetworkAuthority is DSRoles {
  uint8 recoveryRole = 0;

  constructor(address colonyNetwork) public {
    setRecoveryRoleCapability(colonyNetwork, "revertReputationRootHash()");
    setRecoveryRoleCapability(colonyNetwork, "migrateReputationUpdateLogs(address,bool,uint256,uint256)");
    setRecoveryRoleCapability(colonyNetwork, "replaceReputationMiningCycle(address,bool)");
  }

  function setRecoveryRoleCapability(address colony, bytes sig) private {
    bytes4 functionSig = bytes4(keccak256(sig));
    setRoleCapability(recoveryRole, colony, functionSig, true);
  }
}
