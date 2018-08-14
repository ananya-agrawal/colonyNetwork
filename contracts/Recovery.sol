pragma solidity ^0.4.23;
pragma experimental "v0.5.0";

import "../lib/dappsys/auth.sol";

contract Recovery is DSAuth {
  modifier recovery() {
    require(stopped, "not-in-recovery-mode");
    _;
  }

  modifier stoppable {
      require(!stopped, "in-recovery-mode");
      _;
  }

  bool stopped;

  function stop() public auth {
      stopped = true;
  }

  function start() public auth {
      stopped = false;
  }

  function isStopped() public view returns (bool) {
    return stopped;
  }
}
