/*
  This file is part of The Colony Network.

  The Colony Network is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  The Colony Network is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with The Colony Network. If not, see <http://www.gnu.org/licenses/>.
*/

pragma solidity ^0.4.23;
pragma experimental "v0.5.0";

import "./ColonyNetworkStorage.sol";
import "./ReputationMiningCycle.sol";
import "./ERC20Extended.sol";


contract ColonyNetworkMining is ColonyNetworkStorage {
  // TODO: Can we handle a dispute regarding the very first hash that should be set?

  modifier onlyReputationMiningCycle () {
    require(msg.sender == activeReputationMiningCycle, "colony-reputation-mining-sender-not-active-reputation-cycle");
    _;
  }

  function setReputationRootHash(bytes32 newHash, uint256 newNNodes, address[] stakers) public
  stoppable
  onlyReputationMiningCycle
  {
    reputationRootHashHistory.push(ReputationRootHash(newHash, newNNodes));
    reputationRootHash = newHash;
    reputationRootHashNNodes = newNNodes;
    // Reward stakers
    activeReputationMiningCycle = 0x0;
    startNextCycle();
    rewardStakers(stakers);
  }

  function getReputationRootHashHistory(uint256 i) public view returns (bytes32, uint256) {
    return (reputationRootHashHistory[i].rootHash, reputationRootHashHistory[i].nNodes);
  }

  function getReputationRootHashHistoryLength() public view returns (uint256) {
    return reputationRootHashHistory.length;
  }

  function revertReputationRootHash() public auth recovery {
    if (reputationRootHashHistory.length >= 2) {
      ReputationRootHash memory rootHashHistoryItem = reputationRootHashHistory[reputationRootHashHistory.length - 2];
      reputationRootHash = rootHashHistoryItem.rootHash;
      reputationRootHashNNodes = rootHashHistoryItem.nNodes;
    } else {
      reputationRootHash = 0x0;
      reputationRootHashNNodes = 0;
    }
    delete reputationRootHashHistory[reputationRootHashHistory.length - 1];
    reputationRootHashHistory.length--;
  }

  function migrateReputationUpdateLogs(
    address _reputationMiningCycle,
    bool _active,
    uint256 _startingIndex,
    uint256 _batchSize
  ) public auth recovery
  {
    address oldReputationMiningAddress = _active ? activeReputationMiningCycle : inactiveReputationMiningCycle;
    ReputationMiningCycle(oldReputationMiningAddress).transferEntryLogsTo(_reputationMiningCycle, _active, _startingIndex, _batchSize);
  }

  function replaceReputationMiningCycle(address _reputationMiningCycle, bool _active) public auth recovery {
    if (_active) {
      activeReputationMiningCycle = _reputationMiningCycle;
      ReputationMiningCycle(activeReputationMiningCycle).resetWindow();
    } else {
      inactiveReputationMiningCycle = _reputationMiningCycle;
    }
  }

  function initialiseReputationMining() public {
    require(inactiveReputationMiningCycle == 0x0, "colony-reputation-mining-already-initialised");
    address clnyToken = IColony(metaColony).getToken();
    require(clnyToken != 0x0, "colony-reputation-mining-clny-token-invalid-address");
    inactiveReputationMiningCycle = new ReputationMiningCycle(address(this), tokenLocking, clnyToken);
  }

  function startNextCycle() public stoppable {
    address clnyToken = IColony(metaColony).getToken();
    require(clnyToken != 0x0, "colony-reputation-mining-clny-token-invalid-address");
    require(activeReputationMiningCycle == 0x0, "colony-reputation-mining-still-active");
    require(inactiveReputationMiningCycle != 0x0, "colony-reputation-mining-not-initialised");
    // Inactive now becomes active
    activeReputationMiningCycle = inactiveReputationMiningCycle;
    ReputationMiningCycle(activeReputationMiningCycle).resetWindow();
    inactiveReputationMiningCycle = new ReputationMiningCycle(address(this), tokenLocking, clnyToken);
  }

  function getReputationMiningCycle(bool _active) public view returns(address) {
    if (_active) {
      return activeReputationMiningCycle;
    } else {
      return inactiveReputationMiningCycle;
    }
  }

  function rewardStakers(address[] stakers) internal {
    // Internal unlike punish, because it's only ever called from setReputationRootHash

    // TODO: Actually think about this function
    // Passing an array so that we don't incur the EtherRouter overhead for each staker if we looped over
    // it in ReputationMiningCycle.confirmNewHash;
    uint256 reward = 10**18; //TODO: Actually work out how much reputation they earn, based on activity elsewhere in the colony.
    if (reward >= uint256(int256(-1))/2) {
      reward = uint256(int256(-1))/2;
    }
    // TODO: We need to be able to prove that the assert on the next line will never happen, otherwise we're locked out of reputation mining.
    // Something like the above cap is an adequate short-term solution, but at the very least need to double check the limits
    // (which I've fingered-in-the-air, but could easily have an OBOE hiding inside).
    assert(reward < uint256(int256(-1))); // We do a cast later, so make sure we don't overflow.

    IColony(metaColony).mintTokensForColonyNetwork(stakers.length * reward); // This should be the total amount of new tokens we're awarding.

    // This gives them reputation in the next update cycle.
    ReputationMiningCycle(inactiveReputationMiningCycle).rewardStakersWithReputation(stakers, metaColony, reward, rootGlobalSkillId + 2);

    for (uint256 i = 0; i < stakers.length; i++) {
      // Also give them some newly minted tokens.
      ERC20Extended(IColony(metaColony).getToken()).transfer(stakers[i], reward);
    }
  }
}
