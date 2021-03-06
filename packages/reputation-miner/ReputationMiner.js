const BN = require("bn.js");
const web3Utils = require("web3-utils");
const ganache = require("ganache-core");
const ethers = require("ethers");
const patriciaJs = require("./patricia");

// We don't need the account address right now for this secret key, but I'm leaving it in in case we
// do in the future.
// const accountAddress = "0xbb46703786c2049d4d6dd43f5b4edf52a20fefe4";
const secretKey = "0xe5c050bb6bfdd9c29397b8fe6ed59ad2f7df83d6fd213b473f84b489205d9fc7";

// Adapted from https://github.com/ethers-io/ethers.js/issues/59
// ===================================
function RPCSigner(minerAddress, provider) {
  this.address = minerAddress;
  this.provider = provider;
  const signer = this;
  this.sendTransaction = async function sendTransaction(transaction) {
    const tx = await this.buildTx(transaction);
    return signer.provider.send("eth_sendTransaction", [tx]);
  };

  this._ethersType = "Signer";

  this.getAddress = () => this.address;

  this.estimateGas = async function estimateGas(transaction) {
    const tx = this.buildTx(transaction);
    const res = await signer.provider.send("eth_estimateGas", [tx]);
    return ethers.utils.bigNumberify(res);
  };

  this.buildTx = async function buildTx(transaction) {
    const tx = {
      from: this.address
    };
    if (transaction.to != null) {
      tx.to = await transaction.to;
    }
    if (transaction.data !== null) {
      tx.data = transaction.data;
    }

    ["gasPrice", "nonce", "value"].forEach(key => {
      if (transaction[key] != null) {
        tx[key] = ethers.utils.hexlify(transaction[key]);
      }
    });
    if (transaction.gasLimit != null) {
      tx.gas = ethers.utils.hexlify(transaction.gasLimit);
    }
    return tx;
  };
}
// ===================================

class ReputationMiner {
  /**
   * Constructor for ReputationMiner
   * @param {string} minerAddress            The address that is staking CLNY that will allow the miner to submit reputation hashes
   * @param {Number} [realProviderPort=8545] The port that the RPC node with the ability to sign transactions from `minerAddress` is responding on. The address is assumed to be `localhost`.
   */
  constructor({ loader, minerAddress, privateKey, provider, realProviderPort = 8545, useJsTree = false }) {
    this.loader = loader;
    this.minerAddress = minerAddress;

    this.useJsTree = useJsTree;
    if (!this.useJsTree) {
      const ganacheProvider = ganache.provider({
        network_id: 515,
        vmErrorsOnRPCResponse: false,
        locked: false,
        verbose: true,
        accounts: [
          {
            balance: "0x10000000000000000000000000",
            secretKey
          }
        ]
      });
      this.ganacheProvider = new ethers.providers.Web3Provider(ganacheProvider);
      this.ganacheWallet = new ethers.Wallet(secretKey, this.ganacheProvider);
    }

    if (provider) {
      this.realProvider = provider;
    } else {
      this.realProvider = new ethers.providers.JsonRpcProvider(`http://localhost:${realProviderPort}`);
    }

    if (minerAddress) {
      this.realWallet = new RPCSigner(minerAddress, this.realProvider);
    } else {
      this.realWallet = new ethers.Wallet(privateKey, this.realProvider);
      // TODO: Check that this wallet can stake?
      console.log("Transactions will be signed from ", this.realWallet.address);
    }
  }

  /**
   * Initialises the mining client so that it knows where to find the `ColonyNetwork` contract
   * @param  {string}  colonyNetworkAddress The address of the current `ColonyNetwork` contract
   * @return {Promise}
   */
  async initialise(colonyNetworkAddress) {
    this.colonyNetworkContractDef = await this.loader.load({ contractName: "IColonyNetwork" }, { abi: true, address: false });
    this.repCycleContractDef = await this.loader.load({ contractName: "IReputationMiningCycle" }, { abi: true, address: false });

    this.colonyNetwork = new ethers.Contract(colonyNetworkAddress, this.colonyNetworkContractDef.abi, this.realWallet);

    if (this.useJsTree) {
      this.reputationTree = new patriciaJs.PatriciaTree();
    } else {
      this.patriciaTreeContractDef = await this.loader.load({ contractName: "PatriciaTree" }, { abi: true, address: false, bytecode: true });

      const abstractContract = new ethers.Contract(null, this.patriciaTreeContractDef.abi, this.ganacheWallet);
      const contract = await abstractContract.deploy(this.patriciaTreeContractDef.bytecode);
      await contract.deployed();
      this.reputationTree = new ethers.Contract(contract.address, this.patriciaTreeContractDef.abi, this.ganacheWallet);
    }

    this.nReputations = ethers.utils.bigNumberify(0);
    this.reputations = {};
  }

  /**
   * When called, adds the entire contents of the current (active) log to its reputation tree. It also builds a Justification Tree as it does so
   * in case a dispute is called which would require it.
   * @return {Promise}
   */
  async addLogContentsToReputationTree() {
    if (this.useJsTree) {
      this.justificationTree = new patriciaJs.PatriciaTree();
    } else {
      const abstractContract = new ethers.Contract(null, this.patriciaTreeContractDef.abi, this.ganacheWallet);
      const contract = await abstractContract.deploy(this.patriciaTreeContractDef.bytecode);
      await contract.deployed();
      this.justificationTree = new ethers.Contract(contract.address, this.patriciaTreeContractDef.abi, this.ganacheWallet);
    }

    this.justificationHashes = {};
    const addr = await this.colonyNetwork.getReputationMiningCycle(true);
    const repCycle = new ethers.Contract(addr, this.repCycleContractDef.abi, this.realWallet);

    // Do updates

    this.nReputationsBeforeLatestLog = ethers.utils.bigNumberify(this.nReputations.toString());
    // This is also the number of decays we have.

    // How many updates from the logs do we have?
    const nLogEntries = await repCycle.getReputationUpdateLogLength();
    const lastLogEntry = await repCycle.getReputationUpdateLogEntry(nLogEntries.sub(1));
    const totalnUpdates = lastLogEntry[4].add(lastLogEntry[5]).add(this.nReputationsBeforeLatestLog);

    for (let i = ethers.utils.bigNumberify("0"); i.lt(totalnUpdates); i = i.add(1)) {
      await this.addSingleReputationUpdate(i, repCycle); // eslint-disable-line no-await-in-loop
    }
    const prevKey = await this.getKeyForUpdateNumber(totalnUpdates.sub(1));
    const justUpdatedProof = await this.getReputationProofObject(prevKey);
    const newestReputationProof = await this.getNewestReputationProofObject(totalnUpdates);
    const interimHash = await this.reputationTree.getRootHash(); // eslint-disable-line no-await-in-loop
    const jhLeafValue = this.getJRHEntryValueAsBytes(interimHash, this.nReputations);
    const nextUpdateProof = {};
    await this.justificationTree.insert(ReputationMiner.getHexString(totalnUpdates, 64), jhLeafValue, { gasLimit: 4000000 }); // eslint-disable-line no-await-in-loop

    this.justificationHashes[ReputationMiner.getHexString(totalnUpdates, 64)] = JSON.parse(
      JSON.stringify({
        interimHash,
        nNodes: this.nReputations.toString(),
        jhLeafValue,
        justUpdatedProof,
        nextUpdateProof,
        newestReputationProof
      })
    );
  }

  /**
   * Process the `j`th update and add to the current reputation state and the justificationtree.
   * @param  {BigNumber}  updateNumber     The number of the update that should be considered.
   * @return {Promise}
   */
  async addSingleReputationUpdate(updateNumber, repCycle) {
    let interimHash;
    let jhLeafValue;
    let justUpdatedProof;
    let score;
    interimHash = await this.reputationTree.getRootHash(); // eslint-disable-line no-await-in-loop
    jhLeafValue = this.getJRHEntryValueAsBytes(interimHash, this.nReputations);
    let logEntry;
    if (updateNumber.lt(this.nReputationsBeforeLatestLog)) {
      const key = await Object.keys(this.reputations)[updateNumber];
      const reputation = ethers.utils.bigNumberify(`0x${this.reputations[key].slice(2, 66)}`);
      let newReputation;
      // These are the numerator and the denominator of the fraction we wish to reduce the reputation by. It
      // is very slightly less than one.
      // Disabling prettier on the next line so we can have these two values aligned so it's easy to see
      // the fraction will be slightly less than one.
      const numerator   = ethers.utils.bigNumberify("999679150010888");  // eslint-disable-line prettier/prettier
      const denominator = ethers.utils.bigNumberify("1000000000000000");

      if (
        reputation.gt(
          ethers.utils
            .bigNumberify("2")
            .pow(256)
            .sub(1)
            .div(denominator)
        )
      ) {
        newReputation = reputation.div(denominator).mul(numerator);
      } else {
        newReputation = reputation.mul(numerator).div(denominator);
      }
      const reputationChange = newReputation.sub(reputation);
      score = this.getScore(updateNumber, reputationChange);
    } else {
      const logEntryUpdateNumber = updateNumber.sub(this.nReputationsBeforeLatestLog);
      const logEntryNumber = await this.getLogEntryNumberForLogUpdateNumber(logEntryUpdateNumber);
      logEntry = await repCycle.getReputationUpdateLogEntry(logEntryNumber);
      score = this.getScore(updateNumber, logEntry[1]);
    }

    // TODO This 'if' statement is only in for now to make tests easier to write, should be removed in the future.
    if (updateNumber.eq(0)) {
      const nNodes = await this.colonyNetwork.getReputationRootHashNNodes();
      const rootHash = await this.colonyNetwork.getReputationRootHash(); // eslint-disable-line no-await-in-loop
      if (!nNodes.eq(0) && rootHash !== interimHash) {
        console.log("Warning: client being initialized in bad state. Was the previous rootHash submitted correctly?");
      }
      // TODO If it's not already this value, then something has gone wrong, and we're working with the wrong state.
      interimHash = rootHash;
      jhLeafValue = this.getJRHEntryValueAsBytes(interimHash, this.nReputations);
    } else {
      const prevKey = await this.getKeyForUpdateNumber(updateNumber.sub(1));
      justUpdatedProof = await this.getReputationProofObject(prevKey);
    }
    const newestReputationProof = await this.getNewestReputationProofObject(updateNumber);
    await this.justificationTree.insert(ReputationMiner.getHexString(updateNumber, 64), jhLeafValue, { gasLimit: 4000000 }); // eslint-disable-line no-await-in-loop

    const key = await this.getKeyForUpdateNumber(updateNumber);
    const nextUpdateProof = await this.getReputationProofObject(key);
    this.justificationHashes[ReputationMiner.getHexString(updateNumber, 64)] = JSON.parse(
      JSON.stringify({
        interimHash,
        nNodes: this.nReputations.toString(),
        jhLeafValue,
        justUpdatedProof,
        nextUpdateProof,
        newestReputationProof
      })
    );

    const [colonyAddress, skillId, userAddress] = await ReputationMiner.breakKeyInToElements(key);
    // TODO: Include updates for all child skills if x.amount is negative
    // We update colonywide sums first (children, parents, skill)
    // Then the user-specifc sums in the order children, parents, skill.

    // Converting to decimal, since its going to be converted to hex inside `insert`
    const skillIdDecimal = new BN(skillId, 16).toString();
    await this.insert(colonyAddress, skillIdDecimal, userAddress, score, updateNumber);
  }

  /**
   * Get an object containing the key, value, and branchMask and siblings of the merkle proof of the provided key in the current reputation state. If the key
   * does not exist in the current state, returns valid 0-based values for each element (e.g. `0x0` for the branchMask);
   * @return {Promise}    The returned promise will resolve to `[key, value, branchMask, siblings]`
   */
  async getReputationProofObject(key) {
    let branchMask;
    let siblings;
    let value;

    try {
      [branchMask, siblings] = await this.getProof(key); // eslint-disable-line no-await-in-loop
      value = this.reputations[key];
    } catch (err) {
      // Doesn't exist yet.
      branchMask = 0x0;
      siblings = [];
      value = this.getValueAsBytes(0, 0);
    }
    return { branchMask: `${branchMask.toString(16)}`, siblings, key, value, nNodes: this.nReputations.toString() };
  }

  static async getKey(_colonyAddress, _skillId, _userAddress) {
    let colonyAddress = _colonyAddress;
    let userAddress = _userAddress;

    let isAddress = web3Utils.isAddress(colonyAddress);
    // TODO should we return errors here?
    if (!isAddress) {
      return false;
    }
    isAddress = web3Utils.isAddress(userAddress);
    if (!isAddress) {
      return false;
    }
    if (colonyAddress.substring(0, 2) === "0x") {
      colonyAddress = colonyAddress.slice(2);
    }
    if (userAddress.substring(0, 2) === "0x") {
      userAddress = userAddress.slice(2);
    }
    colonyAddress = colonyAddress.toLowerCase();
    userAddress = userAddress.toLowerCase();
    const key = `0x${new BN(colonyAddress, 16).toString(16, 40)}${new BN(_skillId.toString()).toString(16, 64)}${new BN(userAddress, 16).toString(
      16,
      40
    )}`;
    return key;
  }

  // /**
  //  * Convert number to 0x prefixed hex string, where the length discounts the 0x prefix.
  //  * @param  {BN or BigNumber or Number} bnLike
  //  * @param  {Number} length
  //  * @return {String} hexString
  //  * @dev Used to provide standard interface for BN and BigNumber
  //  */
  static getHexString(input, length) {
    return `0x${new BN(input.toString()).toString(16, length)}`;
  }

  /**
   * For update `_i` in the reputationUpdateLog currently under consideration, return the log entry that contains that update. Note that these
   * are not the same number because each entry in the log implies multiple reputation updates. Note that the update number passed here is just
   * the update number in the log, NOT including any decays that may have happened.
   * @param  {Number}  _i The update number we wish to determine which log entry in the reputationUpdateLog creates
   * @return {Promise}   A promise that resolves to the number of the corresponding log entry.
   */
  async getLogEntryNumberForLogUpdateNumber(_i) {
    const updateNumber = _i;
    const addr = await this.colonyNetwork.getReputationMiningCycle(true);
    const repCycle = new ethers.Contract(addr, this.repCycleContractDef.abi, this.realWallet);
    const nLogEntries = await repCycle.getReputationUpdateLogLength();
    let lower = ethers.utils.bigNumberify("0");
    let upper = nLogEntries.sub(1);

    while (!upper.eq(lower)) {
      const testIdx = lower.add(upper.sub(lower).div(2));
      const testLogEntry = await repCycle.getReputationUpdateLogEntry(testIdx); // eslint-disable-line no-await-in-loop
      if (testLogEntry[5].gt(updateNumber)) {
        upper = testIdx.sub(1);
      } else if (testLogEntry[5].lte(updateNumber) && testLogEntry[5].add(testLogEntry[4]).gt(updateNumber)) {
        upper = testIdx;
        lower = testIdx;
      } else {
        lower = testIdx.add(1);
      }
    }

    return lower;
  }

  async getKeyForUpdateNumber(_i) {
    const updateNumber = ethers.utils.bigNumberify(_i);
    if (updateNumber.lt(this.nReputationsBeforeLatestLog)) {
      // Then it's a decay
      return Object.keys(this.reputations)[updateNumber.toNumber()];
    }
    // Else it's from a log entry
    const logEntryNumber = await this.getLogEntryNumberForLogUpdateNumber(updateNumber.sub(this.nReputationsBeforeLatestLog));
    const addr = await this.colonyNetwork.getReputationMiningCycle(true);
    const repCycle = new ethers.Contract(addr, this.repCycleContractDef.abi, this.realWallet);

    const logEntry = await repCycle.getReputationUpdateLogEntry(logEntryNumber);

    const key = await this.getKeyForUpdateInLogEntry(updateNumber.sub(logEntry[5]).sub(this.nReputationsBeforeLatestLog), logEntry);
    return key;
  }

  static async breakKeyInToElements(key) {
    const colonyAddress = key.slice(2, 42);
    const skillId = key.slice(42, 106);
    const userAddress = key.slice(106);
    return [colonyAddress, skillId, userAddress];
  }

  /**
   * Gets the key appropriate for the nth reputation update that logEntry implies.
   * @param  {BigNumber} updateNumber The number of the update the log entry implies we want the information for. Must be less than logEntry[4].
   * @param  {LogEntry}  logEntry An array six long, containing the log entry in question [userAddress, amount, skillId, colony, nUpdates, nPreviousUpdates ]
   * @return {Promise}              Promise that resolves to key
   */
  async getKeyForUpdateInLogEntry(updateNumber, logEntry) {
    let skillAddress;
    // We need to work out the skillId and user address to use.
    // If we are in the first half of 'j's, then we are dealing with global update, so
    // the skilladdress will be 0x0, rather than the user address
    if (updateNumber.lt(logEntry[4].div(2))) {
      skillAddress = "0x0000000000000000000000000000000000000000";
    } else {
      skillAddress = logEntry[0]; // eslint-disable-line prefer-destructuring
      // Following the destructuring rule, this line would be [skillAddress] = logEntry, which I think is very misleading
    }
    const nUpdates = logEntry[4];
    const score = this.getScore(updateNumber.add(this.nReputationsBeforeLatestLog), logEntry[1]);

    const [nParents] = await this.colonyNetwork.getSkill(logEntry[2]);
    let skillId;
    // NB This is not necessarily the same as nChildren. However, this is the number of child updates
    // that this entry in the log was expecting at the time it was created.
    let nChildUpdates;
    // Accidentally commited with gt rather than gte, and everything still
    // worked; was worried this showed a gap in our tests, but the 'else'
    // branch evaluates to zero if score is 0 (because when nUpdates was
    // calculated on-chain, nChildUpdates was zero if score == 0.
    // Restored gte for clarity, but leaving this note for completeness.
    if (score.gte(0)) {
      nChildUpdates = ethers.utils.bigNumberify(0);
    } else {
      nChildUpdates = nUpdates
        .div(2)
        .sub(1)
        .sub(nParents);
    }
    // The list of skill ids to be updated is the same for the first half and the second half of the list of updates this
    // log entry implies, it's just the skillAddress that is different, which we've already established. So
    let skillIndex;
    if (updateNumber.gte(nUpdates.div(2))) {
      skillIndex = updateNumber.sub(nUpdates.div(2));
    } else {
      skillIndex = updateNumber;
    }

    if (skillIndex.lt(nChildUpdates)) {
      // Then the skill being updated is the skillIndex-th child skill
      skillId = await this.colonyNetwork.getChildSkillId(logEntry[2], skillIndex);
    } else if (skillIndex.lt(nChildUpdates.add(nParents))) {
      // Then the skill being updated is the skillIndex-nChildUpdates-th parent skill
      skillId = await this.colonyNetwork.getParentSkillId(logEntry[2], skillIndex.sub(nChildUpdates));
    } else {
      // Then the skill being update is the skill itself - not a parent or child
      skillId = logEntry[2]; // eslint-disable-line prefer-destructuring
    }
    const key = await ReputationMiner.getKey(logEntry[3], skillId, skillAddress);
    return key;
  }

  /**
   * Formats `_reputationState` and `nNodes` in to the format used for the Justification Tree
   * @param  {bigNumber or string} _reputationState The reputation state root hashes
   * @param  {bigNumber or string} nNodes           The number of nodes in the reputation state Tree
   * @return {string}                               The correctly formatted hex string for inclusion in the justification tree
   */
  getJRHEntryValueAsBytes(_reputationState, nNodes) { //eslint-disable-line
    let reputationState = _reputationState.toString(16);
    if (reputationState.substring(0, 2) === "0x") {
      reputationState = reputationState.slice(2);
    }
    return `0x${new BN(reputationState.toString(), 16).toString(16, 64)}${new BN(nNodes.toString()).toString(16, 64)}`;
  }

  /**
   * Formats `reputation` and `uid` in to the format used for the Reputation Tree
   * @param  {bigNumber or string} reputation The reputation score
   * @param  {bigNumber or string} uid        The global UID assigned to this reputation
   * @return {string}            Appropriately formatted hex string
   */
  getValueAsBytes(reputation, uid) { //eslint-disable-line
    return `0x${new BN(reputation.toString()).toString(16, 64)}${new BN(uid.toString()).toString(16, 64)}`;
  }

  /**
   * Get the reputation change from the supplied logEntry
   * @param  {Number} i        The number of the log entry. Not used here, but is in malicious.js to know whether to lie
   * @param  {Array} logEntry The log entry
   * @return {BigNumber}        The entry's reputation change
   * @dev The version of this function in malicious.js uses `this`, but not this version.
   */
  // eslint-disable-next-line class-methods-use-this
  getScore(i, score) {
    return score;
  }

  /**
   * Get the key and value of the most recently added reputation (i.e. the one with the highest UID),
   * and proof (branchMask and siblings) that it exists in the current reputation state.
   * @return {Promise}    The returned promise will resolve to `[key, value, branchMask, siblings]`
   */
  // eslint-disable-next-line no-unused-vars
  async getNewestReputationProofObject(i) {
    // i is unused here, but is used in the Malicious3 mining client.
    const key = Object.keys(this.reputations)[this.nReputations - 1];
    return this.getReputationProofObject(key);
  }

  /**
   * Submit what the client believes should be the next reputation state root hash to the `ReputationMiningCycle` contract
   * @return {Promise}
   */
  async submitRootHash() {
    const addr = await this.colonyNetwork.getReputationMiningCycle(true);
    const repCycle = new ethers.Contract(addr, this.repCycleContractDef.abi, this.realWallet);
    const hash = await this.getRootHash();
    // TODO: Work out what entry we should use when we submit
    const gas = await repCycle.estimate.submitRootHash(hash, this.nReputations, 1);

    return repCycle.submitRootHash(hash, this.nReputations, 1, { gasLimit: `0x${gas.mul(2).toString()}` });
  }

  /**
   * Get what the client believes should be the next reputation state root hash.
   * @return {Promise}      Resolves to the root hash
   */
  async getRootHash() {
    return this.reputationTree.getRootHash();
  }

  /**
   * Get a Merkle proof for `key` in the current (local) reputation state.
   * @param  {string}  key The reputation key the proof is being asked for
   * @return {Promise}     Resolves to [branchMask, siblings]
   */
  async getProof(key) {
    const [branchMask, siblings] = await this.reputationTree.getProof(key);
    const retBranchMask = ReputationMiner.getHexString(branchMask);
    return [retBranchMask, siblings];
  }

  /**
   * Submit the Justification Root Hash (JRH) for the hash that (presumably) we submitted this round
   * @return {Promise}
   */
  async submitJustificationRootHash() {
    const jrh = await this.justificationTree.getRootHash();
    const [branchMask1, siblings1] = await this.justificationTree.getProof(`0x${new BN("0").toString(16, 64)}`);
    const addr = await this.colonyNetwork.getReputationMiningCycle(true);
    const repCycle = new ethers.Contract(addr, this.repCycleContractDef.abi, this.realWallet);
    const nLogEntries = await repCycle.getReputationUpdateLogLength();
    const lastLogEntry = await repCycle.getReputationUpdateLogEntry(nLogEntries.sub(1));
    const totalnUpdates = lastLogEntry[4].add(lastLogEntry[5]).add(this.nReputationsBeforeLatestLog);
    const [branchMask2, siblings2] = await this.justificationTree.getProof(ReputationMiner.getHexString(totalnUpdates, 64));
    const [round, index] = await this.getMySubmissionRoundAndIndex();
    const res = await repCycle.submitJustificationRootHash(round, index, jrh, branchMask1, siblings1, branchMask2, siblings2, { gasLimit: 6000000 });
    return res;
  }

  /**
   * Returns the round and index that our submission is currently at in the dispute cycle.
   * @return {Promise} Resolves to [round, index] which are `BigNumber`.
   */
  async getMySubmissionRoundAndIndex() {
    const submittedHash = await this.reputationTree.getRootHash();
    const addr = await this.colonyNetwork.getReputationMiningCycle(true);
    const repCycle = new ethers.Contract(addr, this.repCycleContractDef.abi, this.realWallet);

    let index = ethers.utils.bigNumberify(-1);
    let round = ethers.utils.bigNumberify(0);
    let submission = [];
    while (submission[0] !== submittedHash) {
      try {
        index = index.add(1);
        submission = await repCycle.getDisputeRounds(round, index); // eslint-disable-line no-await-in-loop
      } catch (err) {
        round = round.add(1);
        index = ethers.utils.bigNumberify(-1);
      }
    }
    return [round, index];
  }

  /**
   * Respond to the next stage in the binary search occurring on `ReputationMiningCycle` contract in order to find
   * the first log entry where our submitted hash and the hash we are paired off against differ.
   * @return {Promise} Resolves to the tx hash of the response
   */
  async respondToBinarySearchForChallenge() {
    const [round, index] = await this.getMySubmissionRoundAndIndex();
    const addr = await this.colonyNetwork.getReputationMiningCycle(true);
    const repCycle = new ethers.Contract(addr, this.repCycleContractDef.abi, this.realWallet);
    const submission = await repCycle.getDisputeRounds(round, index);
    const targetNode = submission[8].add(submission[9]).div(2);
    const targetNodeKey = ReputationMiner.getHexString(targetNode, 64);

    const intermediateReputationHash = this.justificationHashes[targetNodeKey].jhLeafValue;
    const [branchMask, siblings] = await this.justificationTree.getProof(targetNodeKey);
    const tx = await repCycle.respondToBinarySearchForChallenge(round, index, intermediateReputationHash, branchMask, siblings, {
      gasLimit: 1000000
    });
    return tx;
  }

  /**
   * Respond to a specific challenge over the effect of a specific log entry once the binary search has been completed to establish
   * the log entry where the two submitted hashes differ.
   * @return {Promise} Resolves to tx hash of the response
   */
  async respondToChallenge() {
    const [round, index] = await this.getMySubmissionRoundAndIndex();
    const addr = await this.colonyNetwork.getReputationMiningCycle(true);
    const repCycle = new ethers.Contract(addr, this.repCycleContractDef.abi, this.realWallet);
    const submission = await repCycle.getDisputeRounds(round, index);
    // console.log(submission);
    const firstDisagreeIdx = submission[8];
    const lastAgreeIdx = firstDisagreeIdx.sub(1);
    // console.log('getReputationUPdateLogEntry', lastAgreeIdx);
    // const logEntry = await repCycle.getReputationUpdateLogEntry(lastAgreeIdx.toString());
    // console.log('getReputationUPdateLogEntry done');
    const reputationKey = await this.getKeyForUpdateNumber(lastAgreeIdx);
    // console.log('get justification tree');
    const lastAgreeKey = ReputationMiner.getHexString(lastAgreeIdx, 64);
    const firstDisagreeKey = ReputationMiner.getHexString(firstDisagreeIdx, 64);

    const [agreeStateBranchMask, agreeStateSiblings] = await this.justificationTree.getProof(lastAgreeKey);
    const [disagreeStateBranchMask, disagreeStateSiblings] = await this.justificationTree.getProof(firstDisagreeKey);
    let logEntryNumber = ethers.utils.bigNumberify(0);
    if (lastAgreeIdx.gte(this.nReputationsBeforeLatestLog)) {
      logEntryNumber = await this.getLogEntryNumberForLogUpdateNumber(lastAgreeIdx.sub(this.nReputationsBeforeLatestLog));
    }
    // console.log('get justification tree done');

    // These comments can help with debugging. This implied root is the intermediate root hash that is implied
    // const impliedRoot = await this.justificationTree.getImpliedRoot(
    //   reputationKey,
    //   this.justificationHashes[`0x${new BN(lastAgreeIdx).toString(16, 64)}`].nextUpdateProof.value,
    //   this.justificationHashes[`0x${new BN(lastAgreeIdx).toString(16, 64)}`].nextUpdateProof.branchMask,
    //   this.justificationHashes[`0x${new BN(lastAgreeIdx).toString(16, 64)}`].nextUpdateProof.siblings
    // );
    // console.log('intermediatRootHash', impliedRoot);
    // // This one is the JRH implied by the proof provided alongside the above implied root - we expect this to
    // // be the JRH that has been submitted.
    // const impliedRoot2 = await this.justificationTree.getImpliedRoot(
    //   `0x${new BN(lastAgreeIdx).toString(16, 64)}`,
    //   impliedRoot,
    //   agreeStateBranchMask,
    //   agreeStateSiblings
    // );
    // const jrh = await this.justificationTree.getRootHash();
    // console.log('implied jrh', impliedRoot2)
    // console.log('actual jrh', jrh)
    // const impliedRoot3 = await this.justificationTree.getImpliedRoot(
    //   reputationKey,
    //   this.justificationHashes[`0x${new BN(firstDisagreeIdx).toString(16, 64)}`].justUpdatedProof.value,
    //   this.justificationHashes[`0x${new BN(firstDisagreeIdx).toString(16, 64)}`].justUpdatedProof.branchMask,
    //   this.justificationHashes[`0x${new BN(firstDisagreeIdx).toString(16, 64)}`].justUpdatedProof.siblings
    // );
    // const impliedRoot4 = await this.justificationTree.getImpliedRoot(
    //   `0x${new BN(firstDisagreeIdx).toString(16, 64)}`,
    //   impliedRoot3,
    //   disagreeStateBranchMask,
    //   disagreeStateSiblings
    // );
    // console.log('intermediatRootHash2', impliedRoot3);
    // console.log('implied jrh from irh2', impliedRoot4);
    const tx = await repCycle.respondToChallenge(
      [
        round,
        index,
        this.justificationHashes[firstDisagreeKey].justUpdatedProof.branchMask,
        this.justificationHashes[lastAgreeKey].nextUpdateProof.nNodes,
        ReputationMiner.getHexString(agreeStateBranchMask),
        this.justificationHashes[firstDisagreeKey].justUpdatedProof.nNodes,
        ReputationMiner.getHexString(disagreeStateBranchMask),
        this.justificationHashes[lastAgreeKey].newestReputationProof.branchMask,
        "0",
        logEntryNumber,
        "0"
      ],
      reputationKey,
      this.justificationHashes[firstDisagreeKey].justUpdatedProof.siblings,
      this.justificationHashes[lastAgreeKey].nextUpdateProof.value,
      agreeStateSiblings,
      this.justificationHashes[firstDisagreeKey].justUpdatedProof.value,
      disagreeStateSiblings,
      this.justificationHashes[lastAgreeKey].newestReputationProof.key,
      this.justificationHashes[lastAgreeKey].newestReputationProof.value,
      this.justificationHashes[lastAgreeKey].newestReputationProof.siblings,
      { gasLimit: 4000000 }
    );
    return tx;
  }

  /**
   * Insert (or update) the reputation for a user in the local reputation tree
   * @param  {string}  _colonyAddress  Hex address of the colony in which the reputation is being updated
   * @param  {Number or BigNumber or String}  skillId        The id of the skill being updated
   * @param  {string}  _userAddress    Hex address of the user who is having their reputation being updated
   * @param  {Number of BigNumber or String}  reputationScore The amount the reputation changes by
   * @param  {Number or BigNumber}  index           The index of the log entry being considered
   * @return {Promise}                 Resolves to `true` or `false` depending on whether the insertion was successful
   */
  async insert(_colonyAddress, skillId, _userAddress, _reputationScore, index) {
    const key = await ReputationMiner.getKey(_colonyAddress, skillId, _userAddress);
    // const keyAlreadyExists = await this.keyExists(key);
    // If we already have this key, then we lookup the unique identifier we assigned this key.
    // Otherwise, give it the new one.
    let value;
    let newValue;
    const keyAlreadyExists = this.reputations[key] !== undefined;
    if (keyAlreadyExists) {
      // Look up value from our JSON.
      value = this.reputations[key];
      // Extract uid
      const uid = ethers.utils.bigNumberify(`0x${value.slice(-64)}`);
      const existingValue = ethers.utils.bigNumberify(`0x${value.slice(2, 66)}`);
      newValue = existingValue.add(_reputationScore);
      if (newValue.lt(0)) {
        newValue = ethers.utils.bigNumberify(0);
      }
      const upperLimit = ethers.utils
        .bigNumberify(2)
        .pow(256)
        .sub(1);

      if (newValue.gt(upperLimit)) {
        newValue = upperLimit;
      }
      value = this.getValueAsBytes(newValue, uid, index);
    } else {
      newValue = _reputationScore;
      if (newValue.lt(0)) {
        newValue = ethers.utils.bigNumberify(0);
      }
      // A new value can never overflow, so we don't need a 'capping' check here
      value = this.getValueAsBytes(newValue, this.nReputations.add(1), index);
      this.nReputations = this.nReputations.add(1);
    }
    await this.reputationTree.insert(key, value, { gasLimit: 4000000 });
    // If successful, add to our JSON.
    this.reputations[key] = value;
    return true;
  }
}

module.exports = ReputationMiner;
