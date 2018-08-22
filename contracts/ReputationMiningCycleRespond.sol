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

import "../lib/dappsys/math.sol";
import "./IColonyNetwork.sol";
import "./PatriciaTree/PatriciaTreeProofs.sol";
import "./ITokenLocking.sol";
import "./ReputationMiningCycleStorage.sol";


// TODO: Can we handle all possible disputes regarding the very first hash that should be set?
// Currently, at the very least, we can't handle a dispute if the very first entry is disputed.
// A possible workaround would be to 'kick off' reputation mining with a known dummy state...
contract ReputationMiningCycleRespond is ReputationMiningCycleStorage, PatriciaTreeProofs, DSMath {

  /// @notice A modifier that checks that the supplied `roundNumber` is the final round
  /// @param roundNumber The `roundNumber` to check if it is the final round
  modifier finalDisputeRoundCompleted(uint256 roundNumber) {
    require(nSubmittedHashes - nInvalidatedHashes == 1, "colony-reputation-mining-final-round-not-completed");
    require(disputeRounds[roundNumber].length == 1, "colony-reputation-mining-final-round-not-completed"); //i.e. this is the final round
    // Note that even if we are passed the penultimate round, which had a length of two, and had one eliminated,
    // and therefore 'delete' called in `invalidateHash`, the array still has a length of '2' - it's just that one
    // element is zeroed. If this functionality of 'delete' is ever changed, this will have to change too.
    _;
  }

  /// @notice A modifier that checks if the challenge corresponding to the hash in the passed `round` and `id` is open
  /// @param round The round number of the hash under consideration
  /// @param idx The index in the round of the hash under consideration
  modifier challengeOpen(uint256 round, uint256 idx) {
    // TODO: More checks that this is an appropriate time to respondToChallenge
    require(disputeRounds[round][idx].lowerBound == disputeRounds[round][idx].upperBound, "colony-reputation-mining-challenge-closed");
    _;
  }

  /// @notice A modifier that checks if the proposed entry is eligible. The more CLNY a user stakes, the more
  /// potential entries they have in a reputation mining cycle. This is effectively restricting the nonce range
  /// that is allowable from a given user when searching for a submission that will pass `withinTarget`. A user
  /// is allowed to use multiple entries in a single cycle, but each entry can only be used once per cycle, and
  /// if there are multiple entries they must all be for the same proposed Reputation State Root Hash with the
  /// same number of nodes.
  /// @param newHash The hash being submitted
  /// @param nNodes The number of nodes in the reputation tree that `newHash` is the root hash of
  /// @param entryIndex The number of the entry the submitter hash asked us to consider.
  modifier entryQualifies(bytes32 newHash, uint256 nNodes, uint256 entryIndex) {
    // TODO: Require minimum stake, that is (much) more than the cost required to defend the valid submission.
    // Here, the minimum stake is 10**15.
    uint256 balance;
    (, balance) = ITokenLocking(tokenLockingAddress).getUserLock(clnyTokenAddress, msg.sender);
    require(entryIndex <= balance / 10**15, "colony-reputation-mining-stake-minimum-not-met");
    require(entryIndex > 0, "colony-reputation-mining-zero-entry-index-passed");
    // If this user has submitted before during this round...
    if (reputationHashSubmissions[msg.sender].proposedNewRootHash != 0x0) {
      // ...require that they are submitting the same hash ...
      require(newHash == reputationHashSubmissions[msg.sender].proposedNewRootHash, "colony-reputation-mining-submitting-different-hash");
      // ...require that they are submitting the same number of nodes for that hash ...
      require(nNodes == reputationHashSubmissions[msg.sender].nNodes, "colony-reputation-mining-submitting-different-nnodes");
      require(submittedEntries[newHash][msg.sender][entryIndex] == false, "colony-reputation-mining-submitting-same-entry-index"); // ... but not this exact entry
    }
    _;
  }

  uint constant U_ROUND = 0;
  uint constant U_IDX = 1;
  uint constant U_REPUTATION_BRANCH_MASK = 2;
  uint constant U_AGREE_STATE_NNODES = 3;
  uint constant U_AGREE_STATE_BRANCH_MASK = 4;
  uint constant U_DISAGREE_STATE_NNODES = 5;
  uint constant U_DISAGREE_STATE_BRANCH_MASK = 6;
  uint constant U_PREVIOUS_NEW_REPUTATION_BRANCH_MASK = 7;
  uint constant U_REQUIRE_REPUTATION_CHECK = 8;
  uint constant U_LOG_ENTRY_NUMBER = 9;
  uint constant U_DECAY_TRANSITION = 10;

  function respondToChallenge(
    uint256[11] u, //An array of 11 UINT Params, ordered as given above.
    bytes _reputationKey,
    bytes32[] reputationSiblings,
    bytes agreeStateReputationValue,
    bytes32[] agreeStateSiblings,
    bytes disagreeStateReputationValue,
    bytes32[] disagreeStateSiblings,
    bytes previousNewReputationKey,
    bytes previousNewReputationValue,
    bytes32[] previousNewReputationSiblings
  ) public
    challengeOpen(u[U_ROUND], u[U_IDX])
  {
    u[U_REQUIRE_REPUTATION_CHECK] = 0;
    u[U_DECAY_TRANSITION] = 0;
    // TODO: More checks that this is an appropriate time to respondToChallenge (maybe in modifier);
    /* bytes32 jrh = disputeRounds[round][idx].jrh; */
    // The contract knows
    // 1. the jrh for this submission
    // 2. The first index where this submission and its opponent differ.
    // Need to prove
    // 1. The reputation that is updated that we disagree on's value, before the first index
    //    where we differ, and in the first index where we differ.
    // 2. That no other changes are made to the reputation state. The proof for those
    //    two reputations in (1) is therefore required to be the same.
    // 3. That our 'after' value is correct. This is done by doing the calculation on-chain, perhaps
    //    after looking up the corresponding entry in the reputation update log (the alternative is
    //    that it's a decay calculation - not yet implemented.)

    // Check the supplied key is appropriate.
    checkKey(u, _reputationKey, agreeStateReputationValue);

    // Prove the reputation's starting value is in some state, and that state is in the appropriate index in our JRH
    proveBeforeReputationValue(u, _reputationKey, reputationSiblings, agreeStateReputationValue, agreeStateSiblings);

    // Prove the reputation's final value is in a particular state, and that state is in our JRH in the appropriate index (corresponding to the first disagreement between these miners)
    // By using the same branchMask and siblings, we know that no other changes to the reputation state tree have been slipped in.
    proveAfterReputationValue(u, _reputationKey, reputationSiblings, disagreeStateReputationValue, disagreeStateSiblings);

    // Perform the reputation calculation ourselves.
    performReputationCalculation(u, agreeStateReputationValue, disagreeStateReputationValue, previousNewReputationValue);

    // If necessary, check the supplied previousNewRepuation is, in fact, in the same reputation state as the agreeState
    if (u[U_REQUIRE_REPUTATION_CHECK]==1) {
      checkPreviousReputationInState(
        u,
        agreeStateSiblings,
        previousNewReputationKey,
        previousNewReputationValue,
        previousNewReputationSiblings);
      saveProvedReputation(u, previousNewReputationValue);
    }

    // If everthing checked out, note that we've responded to the challenge.
    disputeRounds[u[U_ROUND]][u[U_IDX]].challengeStepCompleted += 1;
    disputeRounds[u[U_ROUND]][u[U_IDX]].lastResponseTimestamp = now;

    // Safety net?
    /* if (disputeRounds[round][idx].challengeStepCompleted==disputeRounds[round][opponentIdx].challengeStepCompleted){
      // Freeze the reputation mining system.
    } */

  }
  /////////////////////////
  // Internal functions
  /////////////////////////

  function checkKey(uint256[11] u, bytes memory _reputationKey, bytes memory _reputationValue) internal {
    // If the state transition we're checking is less than the number of nodes in the currently accepted state, it's a decay transition
    // Otherwise, look up the corresponding entry in the reputation log.
    uint256 updateNumber = disputeRounds[u[U_ROUND]][u[U_IDX]].lowerBound - 1;
    if (updateNumber < IColonyNetwork(colonyNetworkAddress).getReputationRootHashNNodes()) {
      checkKeyDecay(updateNumber, _reputationValue);
      u[U_DECAY_TRANSITION] = 1;
    } else {
      checkKeyLogEntry(u[U_ROUND], u[U_IDX], u[U_LOG_ENTRY_NUMBER], _reputationKey);
    }
  }

  function checkKeyDecay(uint256 _updateNumber, bytes memory _reputationValue) internal {
    uint256 uid;
    bytes memory reputationValue = new bytes(64);
    reputationValue = _reputationValue;
    assembly {
      // NB first 32 bytes contain the length of the bytes object, so we are still correctly loading the second 32 bytes of the
      // reputationValue, which contains the UID
      uid := mload(add(reputationValue,64))
    }
    // We check that the reputation UID is right for the decay transition being disputed.
    // The key is then implicitly checked when they prove that the key+value they supplied is in the
    // right intermediate state in their justification tree.
    require(uid-1 == _updateNumber, "colony-reputation-mining-uid-not-decay");
  }

  function checkKeyLogEntry(uint256 round, uint256 idx, uint256 logEntryNumber, bytes memory _reputationKey) internal {
    uint256 updateNumber = disputeRounds[round][idx].lowerBound - 1 - IColonyNetwork(colonyNetworkAddress).getReputationRootHashNNodes();

    ReputationLogEntry storage logEntry = reputationUpdateLog[logEntryNumber];

    // Check that the supplied log entry corresponds to this update number
    require(updateNumber >= logEntry.nPreviousUpdates, "colony-reputation-mining-update-number-part-of-previous-log-entry-updates");
    require(
      updateNumber < logEntry.nUpdates + logEntry.nPreviousUpdates,
      "colony-reputation-mining-update-number-part-of-following-log-entry-updates");
    uint expectedSkillId;
    address expectedAddress;
    (expectedSkillId, expectedAddress) = getExpectedSkillIdAndAddress(logEntry, updateNumber);

    bytes memory reputationKey = new bytes(20+32+20);
    reputationKey = _reputationKey;
    address colonyAddress;
    address userAddress;
    uint256 skillId;
    assembly {
        colonyAddress := mload(add(reputationKey,20)) // 20, not 32, because we're copying in to a slot that will be interpreted as an address.
                                              // which will truncate the leftmost 12 bytes
        skillId := mload(add(reputationKey, 52))
        userAddress := mload(add(reputationKey,72))   // 72, not 84, for the same reason as above. Is this being too clever? I don't think there are
                                              // any unintended side effects here, but I'm not quite confortable enough with EVM's stack to be sure.
                                              // Not sure what the alternative would be anyway.
    }
    require(expectedAddress == userAddress, "colony-reputation-mining-user-address-mismatch");
    require(logEntry.colony == colonyAddress, "colony-reputation-mining-colony-address-mismatch");
    require(expectedSkillId == skillId, "colony-reputation-mining-skill-id-mismatch");
  }

  function getExpectedSkillIdAndAddress(ReputationLogEntry storage logEntry, uint256 updateNumber) internal view
  returns (uint256 expectedSkillId, address expectedAddress)
  {
    // Work out the expected userAddress and skillId for this updateNumber in this logEntry.
    if ((updateNumber - logEntry.nPreviousUpdates + 1) <= logEntry.nUpdates / 2 ) {
      // Then we're updating a colony-wide total, so we expect an address of 0x0
      expectedAddress = 0x0;
    } else {
      // We're updating a user-specific total
      expectedAddress = logEntry.user;
    }

    // Expected skill Id
    // We update skills in the order children, then parents, then the skill listed in the log itself.
    // If the amount in the log is positive, then no children are being updated.
    uint nParents;
    (nParents, , ) = IColonyNetwork(colonyNetworkAddress).getSkill(logEntry.skillId);
    uint nChildUpdates;
    if (logEntry.amount >= 0) { // solium-disable-line no-empty-blocks, whitespace
      // Then we have no child updates to consider
    } else {
      nChildUpdates = logEntry.nUpdates/2 - 1 - nParents;
      // NB This is not necessarily the same as nChildren. However, this is the number of child updates
      // that this entry in the log was expecting at the time it was created.
    }
    uint256 relativeUpdateNumber = (updateNumber - logEntry.nPreviousUpdates) % (logEntry.nUpdates/2);
    if (relativeUpdateNumber < nChildUpdates) {
      expectedSkillId = IColonyNetwork(colonyNetworkAddress).getChildSkillId(logEntry.skillId, relativeUpdateNumber);
    } else if (relativeUpdateNumber < (nChildUpdates+nParents)) {
      expectedSkillId = IColonyNetwork(colonyNetworkAddress).getParentSkillId(logEntry.skillId, relativeUpdateNumber - nChildUpdates);
    } else {
      expectedSkillId = logEntry.skillId;
    }
  }

  function proveBeforeReputationValue(
    uint256[11] u,
    bytes _reputationKey,
    bytes32[] reputationSiblings,
    bytes agreeStateReputationValue,
    bytes32[] agreeStateSiblings
  ) internal
  {
    bytes32 jrh = disputeRounds[u[U_ROUND]][u[U_IDX]].jrh;
    // We binary searched to the first disagreement, so the last agreement is the one before.
    uint256 lastAgreeIdx = disputeRounds[u[U_ROUND]][u[U_IDX]].lowerBound - 1;
    uint256 reputationValue;
    assembly {
        reputationValue := mload(add(agreeStateReputationValue, 32))
    }

    bytes32 reputationRootHash = getImpliedRoot(_reputationKey, agreeStateReputationValue, u[U_REPUTATION_BRANCH_MASK], reputationSiblings);
    bytes memory jhLeafValue = new bytes(64);
    bytes memory lastAgreeIdxBytes = new bytes(32);
    assembly {
      mstore(add(jhLeafValue, 0x20), reputationRootHash)
      let x := mload(add(u, mul(32,3))) // 3 = U_AGREE_STATE_NNODES. Constants not supported by inline solidity
      mstore(add(jhLeafValue, 0x40), x)
      mstore(add(lastAgreeIdxBytes, 0x20), lastAgreeIdx)
    }
    // Prove that state is in our JRH, in the index corresponding to the last state that the two submissions
    // agree on.
    bytes32 impliedRoot = getImpliedRoot(lastAgreeIdxBytes, jhLeafValue, u[U_AGREE_STATE_BRANCH_MASK], agreeStateSiblings);

    if (reputationValue == 0 && impliedRoot != jrh) {
      // This implies they are claiming that this is a new hash.
      return;
    }
    require(impliedRoot == jrh, "colony-reputation-mining-invalid-before-reputation-proof");
    // They've actually verified whatever they claimed. We increment their challengeStepCompleted by one to indicate this.
    // In the event that our opponent lied about this reputation not existing yet in the tree, they will both complete
    // a call to respondToChallenge, but we will have a higher challengeStepCompleted value, and so they will be the ones
    // eliminated.
    disputeRounds[u[U_ROUND]][u[U_IDX]].challengeStepCompleted += 1;
    // I think this trick can be used exactly once, and only because this is the last function to be called in the challege,
    // and I'm choosing to use it here. I *think* this is okay, because the only situation
    // where we don't prove anything with merkle proofs in this whole dance is here.
  }

  function proveAfterReputationValue(
    uint256[11] u,
    bytes _reputationKey,
    bytes32[] reputationSiblings,
    bytes disagreeStateReputationValue,
    bytes32[] disagreeStateSiblings
  ) internal view
  {
    bytes32 jrh = disputeRounds[u[U_ROUND]][u[U_IDX]].jrh;
    uint256 firstDisagreeIdx = disputeRounds[u[U_ROUND]][u[U_IDX]].lowerBound;
    bytes32 reputationRootHash = getImpliedRoot(_reputationKey, disagreeStateReputationValue, u[U_REPUTATION_BRANCH_MASK], reputationSiblings);
    // Prove that state is in our JRH, in the index corresponding to the last state that the two submissions
    // agree on.
    bytes memory jhLeafValue = new bytes(64);
    bytes memory firstDisagreeIdxBytes = new bytes(32);

    assembly {
      mstore(add(jhLeafValue, 0x20), reputationRootHash)
      let x := mload(add(u, mul(32,5))) // 5 = U_DISAGREE_STATE_NNODES. Constants not supported by inline solidity.
      mstore(add(jhLeafValue, 0x40), x)
      mstore(add(firstDisagreeIdxBytes, 0x20), firstDisagreeIdx)
    }

    bytes32 impliedRoot = getImpliedRoot(firstDisagreeIdxBytes, jhLeafValue, u[U_DISAGREE_STATE_BRANCH_MASK], disagreeStateSiblings);
    require(jrh==impliedRoot, "colony-reputation-mining-invalid-after-reputation-proof");
  }

  function performReputationCalculation(
    uint256[11] u,
    bytes agreeStateReputationValueBytes,
    bytes disagreeStateReputationValueBytes,
    bytes previousNewReputationValueBytes
  ) internal view
  {
    // TODO: Possibility of reputation loss - child reputations do not lose the whole of logEntry.amount, but the same fraction logEntry amount is of the user's reputation in skill given by logEntry.skillId
    ReputationLogEntry storage logEntry = reputationUpdateLog[u[U_LOG_ENTRY_NUMBER]];
    uint256 agreeStateReputationValue;
    uint256 disagreeStateReputationValue;
    uint256 agreeStateReputationUID;
    uint256 disagreeStateReputationUID;

    assembly {
        agreeStateReputationValue := mload(add(agreeStateReputationValueBytes, 32))
        disagreeStateReputationValue := mload(add(disagreeStateReputationValueBytes, 32))
        agreeStateReputationUID := mload(add(agreeStateReputationValueBytes, 64))
        disagreeStateReputationUID := mload(add(disagreeStateReputationValueBytes, 64))
    }

    if (agreeStateReputationUID != 0) {
      // i.e. if this was an existing reputation, then require that the ID hasn't changed.
      // TODO: Situation where it is not an existing reputation
      require(agreeStateReputationUID==disagreeStateReputationUID, "colony-reputation-mining-uid-changed-for-existing-reputation");
    } else {
      uint256 previousNewReputationUID;
      assembly {
        previousNewReputationUID := mload(add(previousNewReputationValueBytes, 64))
      }
      require(previousNewReputationUID + 1 == disagreeStateReputationUID, "colony-reputation-mining-new-uid-incorrect");
      // Flag that we need to check that the reputation they supplied is in the 'agree' state.
      // This feels like it might be being a bit clever, using this array to pass a 'return' value out of
      // this function, without adding a new variable to the stack in the parent function...
      u[U_REQUIRE_REPUTATION_CHECK] = 1;
    }

    // We don't care about underflows for the purposes of comparison, but for the calculation we deem 'correct'.
    // i.e. a reputation can't be negative.
    if (u[U_DECAY_TRANSITION] == 1) {
      // Very large reputation decays are calculated the 'other way around' to avoid overflows.
      if (agreeStateReputationValue > uint256(2**256 - 1)/uint256(10**15)) {
        require(disagreeStateReputationValue == (agreeStateReputationValue/1000000000000000)*999679150010888, "colony-reputation-mining-decay-incorrect");
      } else {
        require(disagreeStateReputationValue == (agreeStateReputationValue*999679150010888)/1000000000000000, "colony-reputation-mining-decay-incorrect");
      }
    } else {
      if (logEntry.amount < 0 && uint(logEntry.amount * -1) > agreeStateReputationValue ) {
        require(disagreeStateReputationValue == 0, "colony-reputation-mining-reputation-value-non-zero");
      } else if (uint(logEntry.amount) + agreeStateReputationValue < agreeStateReputationValue) {
        // We also don't allow reputation to overflow
        require(disagreeStateReputationValue == 2**256 - 1, "colony-reputation-mining-reputation-not-max-uint");
      } else {
        // TODO: Is this safe? I think so, because even if there's over/underflows, they should
        // still be the same number.
        require(int(agreeStateReputationValue)+logEntry.amount == int(disagreeStateReputationValue), "colony-reputation-mining-invalid-newest-reputation-proof");
      }
    }
  }

  function checkPreviousReputationInState(
    uint256[11] u,
    bytes32[] agreeStateSiblings,
    bytes previousNewReputationKey,
    bytes previousNewReputationValue,
    bytes32[] previousNewReputationSiblings
    ) internal view
  {
    // We binary searched to the first disagreement, so the last agreement is the one before
    uint256 lastAgreeIdx = disputeRounds[u[U_ROUND]][u[U_IDX]].lowerBound - 1;

    bytes32 reputationRootHash = getImpliedRoot(
      previousNewReputationKey,
      previousNewReputationValue,
      u[U_PREVIOUS_NEW_REPUTATION_BRANCH_MASK],
      previousNewReputationSiblings
    );
    bytes memory jhLeafValue = new bytes(64);
    bytes memory lastAgreeIdxBytes = new bytes(32);
    assembly {
      mstore(add(jhLeafValue, 0x20), reputationRootHash)
      let x := mload(add(u, mul(32,3))) // 3 = U_AGREE_STATE_NNODES. Constants not supported by inline assembly
      mstore(add(jhLeafValue, 0x40), x)
      mstore(add(lastAgreeIdxBytes, 0x20), lastAgreeIdx)
    }
    // Prove that state is in our JRH, in the index corresponding to the last state that the two submissions agree on
    bytes32 impliedRoot = getImpliedRoot(lastAgreeIdxBytes, jhLeafValue, u[U_AGREE_STATE_BRANCH_MASK], agreeStateSiblings);
    require(impliedRoot == disputeRounds[u[U_ROUND]][u[U_IDX]].jrh, "colony-reputation-mining-last-state-disagreement");
  }

  function saveProvedReputation(uint256[11] u, bytes previousNewReputationValue) internal {
    uint256 previousReputationUID;
    assembly {
      previousReputationUID := mload(add(previousNewReputationValue,0x40))
    }
    // Save the index for tiebreak scenarios later.
    disputeRounds[u[U_ROUND]][u[U_IDX]].provedPreviousReputationUID = previousReputationUID;
  }


}
