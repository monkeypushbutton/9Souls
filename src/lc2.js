// TODO: Kittens massacre in year 1 due to building too many huts. Sad but not a deal breaker.
// TODO: UI often doesn't refresh after script takes an action. Smelters going on and off are a case in point.
// TODO: LP Still wants to assign kittens to e.g. scientist when resource is at max at certain points. I'm manually correcting for it right now, which sucks.
// TODO: Tabs havre to be visited before buttons etc are rendered to Dom to be able to be clicked. Script should ensure that available tabs have been rendered.
// TODO: Add variable and implementation for steamworks on vs off. I have a hunch that off with be the right choice 95% of time at least until magnetos.

// NB: Season is ~ 200 seconds long. 
var executeIntervalSeconds = 10;
var plannedSeason = -1;
var reservedFarmers = 0;
var plannedKittens = 0;
var plannedButtons = [];

var eventLoops = {
    execHandle: undefined,
    gatherHandle: undefined
};

function planHorizonSeconds(){
    return (100 - gamePage.calendar.day) * 2;
}

//#region Control Of event loops
function go() {
    restartExecLoop();
}

function stopLoop(handleName){
    if(eventLoops[handleName]){
        clearInterval(eventLoops[handleName]);
        eventLoops[handleName] = undefined;
    }
}

function stop(){
    for(var handle in eventLoops){
        if(eventLoops[handle]){
            console.log("Stopping " + handle);
            stopLoop(handle);
        }
    }
}

function controlGatherLoop(){
    var nipInfo = game.resPool.resources[0];
    if(nipInfo.value > 1000 || nipInfo.perTickCached > 2){
        stopLoop('gatherHandle');
    }
    else 
        restartGatherLoop();
}

function restartGatherLoop(){
    stopLoop('gatherHandle');
    // ~7 nip per second, about as fast as I can spam click.
    eventLoops.gatherHandle = setInterval(() => game.bldTab.children[0].buttonContent.click(), 150);
}

function restartExecLoop(){
    stopLoop('execHandle');
    executePlanNow();
    eventLoops.execHandle = setInterval(executePlanNow, executeIntervalSeconds * 1000);
}

//#endregion

//#region Execution

function executePlanNow(timesBought = 0){
    console.log("Executing");
    praiseUnderPlan();
    if(gamePage.calendar.season != plannedSeason){
        console.log("Replanning (season)");
        planNow();
    }
    if(getBuyables().length != plannedButtons.length){
        //Mainly so we don't have to wait a whole season to build a field :-)
        console.log("Replanning (possibilities changed)");
        planNow();
    }
    if(game.resPool.get("kittens").value != plannedKittens){        
        //Mainly so we don't have to wait a whole season to build a field :-)
        console.log("Replanning (kittens changed)");
        planNow();
    }
    console.time("executePlan");
    promoteUnderPlan();
    observeTheSky();
    controlGatherLoop();
    executeHunts();
    executeExplore();
    executeTrades();
    executeCrafts();
    assignJobs();
    executeToggleBuildings();
    sacrificeUnderPlan();
    var bought = false;
    if(timesBought < 5){
        bought = buyUnderPlan();
    }
    console.timeEnd("executePlan");
    if(bought){
        console.log("Replanning (bought something)");
        planNow();
        executePlanNow(timesBought + 1);
    }
}

function observeTheSky(){
    if(gamePage.calendar.observeBtn){
        console.debug("Observing...")
        gamePage.calendar.observeBtn.click();
    }
}

//#endregion

var plan;
var model;
var executedPlan;
function planNow(){
    console.time("planNow");
    plannedSeason = gamePage.calendar.season;
    plannedButtons = getBuyables();
    plannedKittens = game.resPool.get("kittens").value;
    model = buildModel();
    plan = solver.Solve(model);
    executedPlan = {};
    console.log(model);
    console.log(plan);
    console.timeEnd("planNow");
}

function secretUnlocks() {
    // NB: Most of these are now implemented by adding a utility to the action we want to take at a certain point
    // e.g. refine wood early game, assign a kitten to minerals etc etc.

    // What other secrets are out there!?
    return [];
}

function limitedResources(btn){
    //console.log(buttonId(btn), btn)
    var limitedResources = []
    for(cost of btn.model.prices){
        var resMax = game.resPool.get(cost.name).maxValue
        if(resMax && resMax < cost.val)
            limitedResources.push(cost)
    }
    return limitedResources;
}

function isFeasible(btn){
    return limitedResources(btn).length == 0 || canSwapLeaderToPurchase(btn) != null;
}

function canAffordNow(btn){
    return canAffordHowManyNow(btn) >= 1  || canSwapLeaderToPurchase(btn, false) != null;
}

function canAffordHowManyNow(btn){
    limitedAmount = Infinity
    //console.debug("Checking if I can afford ", buttonId(btn))
    for(pe of btn.model.prices){
        reservedRes = 0
        if(pe.name == "catnip")
            reservedRes = reservedNipAmount()
        resPoolRes = gamePage.resPool.resourceMap[pe.name].value;
        availableResources = Math.max(resPoolRes - reservedRes, 0)
        ratio = availableResources / pe.val
        if(ratio < 1) {
            //console.debug("I don't have enough ", pe.name, " need ", pe.val, " have ", availableResources, reservedRes == 0 ? "" : " (not including " + reservedRes + " reserved) ")
            return ratio;
        }
        //console.debug("I have enough ", pe.name, " need ", pe.val, " have ", resPoolRes)
        if(ratio < limitedAmount)
            limitedAmount = ratio
    }
    return limitedAmount;
}

function buildModel() {
    model = {
        optimize: "utility",
        opType: "max",
        variables: {},
        constraints: {},
        ints: {}
    };
    var outOfReach = getBuyables(false);
    for(btn of getBuyables()){
        buyVariable = variableFromButton(btn, outOfReach);
        model.variables[buyVariable.name] = buyVariable;
    }
    for(job of getJobAssignments()){
        jobVariable = variableFromJobAssignment(job);
        model.variables[jobVariable.name] = jobVariable;
        model.ints[jobVariable.name] = true;
    }
    for(race of getTradeableRaces()){
        tradeVariable = variableFromTrade(race);
        model.variables[tradeVariable.name] = tradeVariable;
        model.ints[tradeVariable.name] = true;
    }
    for(craftBtn of getCrafts()){
        craftVariable = variableFromCraft(craftBtn);
        model.variables[craftVariable.name] = craftVariable;
    }
    for(incrementableBld of getIncrementableBuildings()){
        bldName = buttonId(incrementableBld);
        bldNumVar = variableFromIncrementableBuilding(incrementableBld);
        model.variables[bldNumVar.name] = bldNumVar;
        model.constraints[bldName] = { max: incrementableBld.val };
    }
    for(res of game.resPool.resources) {
        if(res.name == "catnip"){
            var emergencyNip = reservedNipAmount();
            model.constraints[res.name] = {
                max: Math.max(projectResourceAmount(res) - emergencyNip, 0)
            }
        } else {
            model.constraints[res.name] = {
                max: projectResourceAmount(res)
            }
        }
    }
    var promoteVariable = variableForPromoteLeader();
    if(promoteVariable)
        model.variables[promoteVariable.name] = promoteVariable;
    var huntVariable = variableFromHunt();
    if(huntVariable)
        model.variables[huntVariable.name] = huntVariable;
    var exploreVar = variableFromExplore();
    if(exploreVar){
        model.constraints[exploreVar.name] = {min: 0, max: 1}
        model.variables[exploreVar.name] = exploreVar;
    }
    var praiseSunVar = variableForPraiseSun();
    if(praiseSunVar){
        model.variables[praiseSunVar.name] = praiseSunVar;
    }
    var sacVariable = variableForSacrifice();
    if(sacVariable){
        model.variables[sacVariable.name] = sacVariable;
    }
    reservedFarmers = reserveFarmers();
    model.constraints.kittens.max -= reservedFarmers;
    return model;
}

//#region Buyables
function getBuyables(feasible = true) {
    //console.time("getBuyables");
    // console.time("bldTab.render");
    // gamePage.bldTab.render();    
    // console.timeEnd("bldTab.render");
    buyable = gamePage.bldTab.children.slice(2).filter(b => isFeasible(b) == feasible);
    
    if(gamePage.libraryTab.visible){
        // console.time("libraryTab.render");
        // gamePage.libraryTab.render();
        // console.timeEnd("libraryTab.render");
        buyable = buyable.concat(gamePage.libraryTab.buttons.filter(b => b.model.visible && isFeasible(b) == feasible && !b.model.metadata.researched));
        if(gamePage.libraryTab.policyPanel.visible){
            buyable = buyable.concat(gamePage.libraryTab.policyPanel.children.filter(b => b.model.visible && isFeasible(b) == feasible && !b.model.metadata.researched))
        }
    }
    if(gamePage.workshopTab.visible){
        // gamePage.workshopTab.render();
        buyable = buyable.concat(gamePage.workshopTab.buttons.filter(b => b.model.visible && isFeasible(b) == feasible && !b.model.metadata.researched));
    }
    if(gamePage.diplomacyTab.visible){
        // gamePage.diplomacyTab.render();
        buyable = buyable.concat(gamePage.diplomacyTab.racePanels.map(rp => rp.embassyButton).filter(b => b.model.visible && isFeasible(b) == feasible));
    }
    if(gamePage.religionTab.visible){
        // gamePage.religionTab.render();
        buyable = buyable.concat(gamePage.religionTab.rUpgradeButtons.filter(btn => btn.model.visible && isFeasible(btn) == feasible && !(btn.model.metadata.noStackable && btn.model.metadata.val != 0 )));
        if(game.bld.get("ziggurat").val > 0){
            buyable = buyable.concat(gamePage.religionTab.zgUpgradeButtons.filter(zu => zu.model.visible && isFeasible(zu) == feasible))
        }

        //gamePage.religionTab.zgUpgradeButtons

    }
    buyable = buyable.concat(secretUnlocks());
    //console.timeEnd("getBuyables");
    return buyable;
}

function variableFromButton(btn, outOfReach){
    variable = {
        name: "Build|" + buttonId(btn),
        utility: buttonUtility(btn, outOfReach)
    }
    for(pe of btn.model.prices){
        variable[pe.name] = pe.val * leaderDiscountRatio(btn, pe.name);
    }
    return variable;
}

function buttonUtility(btn, outOfReach = null){
    // Some buildings are just really good and some are real stinkers in the context of this script.
    var id = buttonId(btn)
    var utility = 0;
    // Never or almost never useful. We hopefuly aren't going to hover max resources with this script.
    if(id == "factoryAutomation")
        utility = 0.1;
    // Faith upgrades are pretty important, as are science and workshop.
    // Incentivise them as they tend to look expensive to the optimiser.
    else if(btn.model.prices.find(p => p.name == "faith"))
        utility = 4;
    else if(btn.tab && btn.tab.tabId == "Science")
        utility = 10;
    else if(btn.tab && btn.tab.tabId == "Workshop")
        utility = 8;
    // Embassies have diminishing returns.
    else if(btn.race){
        // TODO: Should Embassy returns be based somewhat on unlocks?
        var baseutility = 1.5;
        var builtAlready = btn.model.metadata.val;
        utility = baseutility - game.getLimitedDR(builtAlready, baseutility);
    }
    else if(gamePage.bld.buildingsData.find(bd => bd.name == id)) {
        var baseutility = 2;
        // Buildings I hope??
        if(id == 'workshop')
            baseutility = 5;
        // Hunting is just more a straight up more efficient use of manpower.
        else if(id == "mint")
            baseutility = 0.2;
        else if(gamePage.bld.buildingGroups.find(bg => bg.name == "population").buildings.includes(id))
            baseutility =  6;
        // We're almost blocked by max science in early game at least.
        // No longer needed after incentiviseStorage stuff.
        // else if(gamePage.bld.buildingGroups.find(bg => bg.name == "science").buildings.includes(id))
        //     baseutility =  4;
        // Give them diminishing returns to incentivise climbing the tech tree faster.
        var builtAlready = btn.model.metadata.val
        //console.log(id, baseutility, builtAlready)
        utility = baseutility - game.getLimitedDR(builtAlready, baseutility);
        // Storage buildings are more useful than they appear naively, beacause we want to push up the tech tree for example.
        if(outOfReach && Object.keys(btn.model.metadata.effects).find(e => e.endsWith("Max")) ){
            //console.log("Extra utility for storage on object %s", buttonId(btn))
            for(var infeasible of outOfReach){
                var infeasibleUtility = buttonUtility(infeasible) / 10;
                //console.log("  Extra utility infeasible %s with base utility %f", buttonId(infeasible), infeasibleUtility)
                for(var price of infeasible.model.prices){
                    var resource = game.resPool.get(price.name);
                    if( resource.maxValue < price.val ){
                        var extraCap = price.val - resource.maxValue;
                        var capIncrease = btn.model.metadata.effects[resource.name + "Max"] || 0;
                        var percentOfRequired = Math.min(capIncrease / extraCap, 1);
                        if(percentOfRequired > 0){
                            //console.log("  %s has capped price %s, needs %f extra cap, button %s constributes %f which is %f percent of needed for %f extra utility.", buttonId(infeasible), price.name, extraCap, buttonId(btn), capIncrease , percentOfRequired * 100, infeasibleUtility * percentOfRequired)
                            utility += infeasibleUtility * percentOfRequired;
                        }
                    }
                }
            }
        }
    }
    else {
        utility = 1;
    }
    // Jittery
    return utility * (1 + Math.random() / 10);
}

function buyUnderPlan(){
    bought = false
    var allBuyable = getBuyables();
    for(buyable in plan){
        if(!buyable.startsWith('Build'))
            continue;
        var numToBuy = plan[buyable];
        if(numToBuy < 1)
            continue;
        var label = buyable.slice(6);
        var buyButtons = allBuyable.filter(b => buttonId(b) == label);
        if(buyButtons.length != 1){
            console.warn("Unknown or ambiguous buyable " + buyable + " this action cannot be performed at this time.");
            continue;
        }
        buyButton = buyButtons[0];
        if(canAffordNow(buyButton)){
            var prevLeader = switchLeaderToBuy(buyButton);
            console.log('Buying ' + label);
            //console.debug(buyButton);
            //console.debug(buyButton.buttonContent);
            window.setTimeout(() => {
                buyButton.buttonContent.click();
                changeLeader(prevLeader);
            }, 50)
            // TODO: Dismiss policy popup.
            bought = true;
        }
    }
    return bought;
}
//#endregion

//#region Jobs
/* 
To stop kittens from starving sometimes we need to ensure a supply of farmers. 
Make sure a minimum number of kittens can farm if we project that nip will fall below our reserve threshold.
*/

function reserveFarmers(){
    //var jobLog = woodman.getLogger("main.Jobs");
    var farmerJob = gamePage.village.getJob('farmer');
    if(!farmerJob.unlocked)
        return 0; // Can't reserver a farmer if it's not unlocked.
    var nipRes = gamePage.resPool.get('catnip');
    var projectedNip = projectResourceAmount(nipRes);
    var desiredEmergencyStash = reservedNipAmount();
    var desiredAdditionalNip = desiredEmergencyStash - projectedNip;
    if(desiredAdditionalNip <= 0)
        return 0; // No extra nip needed.
    var nipPerFarmer = resoucePerTick(nipRes, 1, farmerJob);
    var desiredAdditionalNipPerTick = desiredAdditionalNip / (planHorizonSeconds() * gamePage.ticksPerSecond);
    var desiredReservedFarmers = desiredAdditionalNipPerTick / nipPerFarmer;
    var reservedFarmers = Math.min(gamePage.resPool.get('kittens').value, Math.ceil(desiredReservedFarmers));
    // jobLog.info("Projected 'nip %i, desired stash %i, additional extra nip per tick %f, farmer increment %f, desiredReservedFarmers %i", 
    //     projectedNip,
    //     desiredEmergencyStash,
    //     desiredAdditionalNipPerTick,
    //     nipPerFarmer,
    //     reservedFarmers
    //     );
    return reservedFarmers;
}

function getJobAssignments() {
    if(!gamePage.villageTab.visible)
        return []
    gamePage.villageTab.render();
    return game.village.jobs.filter(j => j.unlocked);
}

function variableFromJobAssignment(j) {
    jv = {
        name: "Job|" + buttonId(j),
        kittens: 1
    };
    for(mod in j.modifiers){        
        var jobProduction = resoucePerTick(gamePage.resPool.resourceMap[mod], 1, j);
        jv[mod] = -1 * jobProduction * planHorizonSeconds() * game.ticksPerSecond
    }
    // Little jack to incentivise unlocking workshop
    if(j.name == "miner" && !gamePage.bld.get("workshop").unlocked){
        jv.utility = 1;
    }
    // TODO: Moderate the benefits of the priesthood.
    else if (j.name == "priest"){
        if(!gamePage.religionTab.visible){
            // Yeah - we should unlock that ;-)
            jv.utility = 1;
        }
    }
    return jv;
}

function jobResourcesMaxed(job){
    for(var modifier in job.modifiers){
        var modifiedResource = game.resPool.get(modifier);
        if(modifiedResource.value < modifiedResource.maxValue)
            return false;
    }
    return true;
}

function assignJobs(){
    var jobLog = woodman.getLogger("main.Jobs");
    var jobNumbers = {assignments: {}, invalidJobs: []};
    var kittensAssigned = 0;
    var jobs = getJobAssignments();
    // remove kittens from jobs 
    for(j of jobs){
        var numPlanned = Math.floor(plan["Job|" + buttonId(j)] || 0);
        if(j.name == "farmer")
            numPlanned += reservedFarmers;
        // Remove assignments from maxxed out jobs.
        if(numPlanned != 0 && jobResourcesMaxed(j)){
            //jobLog.log("Waste detection for kittens doing ", j.name , " all kittens doing this will be reallocated.");
            numPlanned = 0;
            jobNumbers.invalidJobs.push(j.name)
        }
        jobNumbers.assignments[j.name] = numPlanned;
        kittensAssigned += numPlanned;
    }
    var redistributableJobs = jobs.length - jobNumbers.invalidJobs.length
    var totalSpareKittens = Math.max(game.village.getKittens() - kittensAssigned, 0);    
    var remainingSpareKittens = totalSpareKittens;
    for (var jobName in jobNumbers.assignments){
        if(remainingSpareKittens <= 0)
            break;
        if(jobNumbers.invalidJobs.includes(jobName))
            continue;
        var extraForJob = Math.min(Math.ceil(
            kittensAssigned == 0 
            ? game.village.getKittens() / redistributableJobs
            : totalSpareKittens * jobNumbers.assignments[jobName] / kittensAssigned), remainingSpareKittens);
        //var explain = kittensAssigned == 0 ? " no valid assignments, equal chances" : " ratio of valid assignments (" + totalSpareKittens + " * " + jobNumbers[jobName] + "/" + kittensAssigned + ")"
        //jobLog.log("Assigning %i spare kittens to %s, I had %i remaining before this assignment. Made this assignment because of %s", extraForJob, jobName, remainingSpareKittens, explain);
        remainingSpareKittens -= extraForJob;
        jobNumbers.assignments[jobName] += extraForJob;
    }
    //jobLog.log(jobNumbers)
    for(var jobName in jobNumbers.assignments) {
        var numPlanned = jobNumbers.assignments[jobName];
        var j = game.village.getJob(jobName)
        //jobLog.log("Planned to assign ", numPlanned, " for job ", j.name, " currently job has ", j.value, " kittens assigned")
        if(j.value > numPlanned){
            var numToRemove = j.value - numPlanned;
            jobLog.log("Need to remove %i kittens from job %s (assigned %i, planned %i)", numToRemove, jobName, j.value, numPlanned);
            var jobBtn = gamePage.villageTab.buttons.find(b => b.opts.job == j.name);
            if(numPlanned < 1){
                //jobLog.debug("Removing all kittens from job ", j.name);
                jobBtn.unassignLinks.unassignAll.link.click();
                continue;
            }
            while(numToRemove > 0){
                if(numToRemove >= 25){
                    //jobLog.debug("Removing 25 kittens from job ", j.name);
                    jobBtn.unassignLinks.unassign25.link.click();
                    numToRemove -= 25;
                } else if (numToRemove >= 5) {
                    //jobLog.debug("Removing 5 kittens from job ", j.name);
                    jobBtn.unassignLinks.unassign5.link.click();
                    numToRemove -= 5;
                } else {
                    //jobLog.debug("Removing kitten from job ", j.name);
                    jobBtn.unassignLinks.unassign.link.click();
                    numToRemove -= 1;
                }
            }
        }
    }
    // assign kittens to jobs
    for(var jobName in jobNumbers.assignments) {
        var numPlanned = jobNumbers.assignments[jobName];
        var j = game.village.getJob(jobName)
        if(j.value < numPlanned){
            var jobBtn = gamePage.villageTab.buttons.find(b => b.opts.job == j.name);
            var numToAdd = numPlanned - j.value;
            jobLog.log("Need to add %i kittens to job %s (assigned %i, planned %i)", numToAdd, jobName, j.value, numPlanned);
            if(numToAdd == gamePage.village.getFreeKittens()){
                //jobLog.debug("Adding all free kittens to job ", j.name);
                jobBtn.assignLinks.assignall.link.click();
                return;
            }
            while(numToAdd > 0){
                if(numToAdd >= 25){
                    //jobLog.debug("Adding 25 kittens to job ", j.name);
                    jobBtn.assignLinks.assign25.link.click();
                    numToAdd -= 25;
                } else if (numToAdd >= 5) {
                    //jobLog.debug("Adding 5 kittens to job ", j.name);
                    jobBtn.assignLinks.assign5.link.click();
                    numToAdd -= 5;
                } else {
                    //jobLog.debug("Adding kitten to job ", j.name);
                    jobBtn.assignLinks.assign.link.click();
                    numToAdd -= 1;
                }
            }
        }
    }
    // TODO: Partial kittens
    // TODO: Optimise when required.
}

//#endregion

//#region Trades
function getTradeableRaces() {
    return gamePage.diplomacy.races.filter(r => r.unlocked);
}

function variableFromTrade(tradeRace) {
    // TODO: Pretty sure I'm not doing tradeRatio correctly - is there a better way to simulate this as with production
    // diplomacy.tradeImpl, but without side effects?
    var ratio = game.diplomacy.getTradeRatio();
    tv = {
        name: "Trade|" + buttonId(tradeRace),
        manpower: 50,
        gold: 15,
        blueprint: -0.1
    };
    for(res of tradeRace.buys){
        tv[res.name] = res.val;
    }
    var bonusForLeaderSwitch = tradeBonusForLeaderSwitch();
    var standingRatio = game.getEffect("standingRatio") + game.diplomacy.calculateStandingFromPolicies(tradeRace.name, game);
    var failureChance = tradeRace.standing < 0 ? -(tradeRace.standing + standingRatio) / 2 : 0;
    var bonusTradeChance = tradeRace.standing > 0 ? tradeRace.standing + standingRatio / 2 : 0;
    var tradeRatio = 1 + bonusForLeaderSwitch + game.diplomacy.getTradeRatio() + game.diplomacy.calculateTradeBonusFromPolicies(tradeRace.name, game) + game.challenges.getChallenge("pacifism").getTradeBonusEffect(game);
    var raceRatio = 1 + race.energy * 0.02;
    var currentSeason = this.game.calendar.getCurSeason().name;
    var embassyEffect = this.game.ironWill ? 0.0025 : 0.01;
    
    
    for(sellResource of tradeRace.sells){
        //console.debug(res, tradeRace, res.minLevel, tradeRace.embassyLevel)
        // Mostly cribbed from diplomacy.tradeImpl
        if (!game.diplomacy.isValidTrade(sellResource, tradeRace)) {
            continue;
        }
        var tradeChance = sellResource.chance *
            (1 + (
                tradeRace.embassyPrices ?
                game.getLimitedDR(tradeRace.embassyLevel * embassyEffect, 0.75) :
                0)
            );
        var resourceSeasonTradeRatio = 1 + (sellResource.seasons ? sellResource.seasons[currentSeason] : 0);
        expected = 
            // Basic amount specified
            sellResource.value
            // Trades for hostile races may fail completely
            * (1 - failureChance)
            // Trades with friendly races sometimes give you 25% extra
            * (1 + (0.25 * bonusTradeChance))
            // Rare resources only have some % chance to drop
            * tradeChance 
            // Tradepost etc.
            * tradeRatio
            // Leviathans I think - haven't got that far yet.
            * raceRatio
            // Seasonality of resources
            * resourceSeasonTradeRatio;
        //console.debug(sellResource.value, failureChance, bonusTradeChance, tradeChance, tradeRatio, raceRatio, resourceSeasonTradeRatio)
        //console.debug(expected)

        /*We can't actually store more than our Max amount. I'm looking at you Sharks...
  \.          |\
   \`.___---~~  ~~~--_
   //~~----___  (_o_-~
  '           |/'
        */
        sellResource = game.resPool.get(sellResource.name);
        reserved = sellResource.name == "catnip" ? reservedNipAmount() : 0;
        if(sellResource.maxValue)
            expected = Math.min(expected, sellResource.maxValue - reserved);
        tv[sellResource.name] = -expected
    }

    tv.spice = -0.35 * (1 + (tradeRace.embassyPrices ?  tradeRace.embassyLevel * embassyEffect : 0))
    //-------------- 15% + 0.35% chance per ship to get titanium ---------------
    if (tradeRace.name == "zebras") {
        var shipAmount = game.resPool.get("ship").value;
        var zebraRelationModifierTitanium = game.getEffect("zebraRelationModifier") * game.bld.getBuildingExt("tradepost").meta.effects["tradeRatio"];
        tv.titanium = -(1.5 + shipAmount * 0.03) * (1 + zebraRelationModifierTitanium) * ((0.15 + shipAmount * 0.0035) / 2);
    }

    // Trades can generate Spice, which is a luxury. Grant some utility for that if we are below some threshold.
    var spiceRes = game.resPool.get("spice");
    var spiceCons = resoucePerTick(spiceRes);
    if(projectResourceAmount(spiceRes) < -1 * spiceCons * game.ticksPerSecond * planHorizonSeconds()){
        tv.utility = 0.05;
    }    
    return tv;
}

function executeTrades(){
    for(tradeable in plan) {
        if(!tradeable.startsWith("Trade")){
            continue;
        }
        desiredTrades = (plan[tradeable] || 0);
        executedTrades = (executedPlan[tradeable] || 0);
        desiredRemainingTrades = desiredTrades - executedTrades;
        if(desiredRemainingTrades < 1)
            return;
        raceName = tradeable.slice(6);
        tradeBtn = gamePage.diplomacyTab.racePanels.find(rp => rp.race.name == raceName).tradeBtn
        tradesPossibleNow = Math.floor(canAffordHowManyNow(tradeBtn));
        if(tradesPossibleNow < 1)
            return;
        if(tradesPossibleNow < 1)
            return;
        tradesToPerform = Math.min(desiredRemainingTrades, tradesPossibleNow)
        if(tradesToPerform <= 0)
            return;
        var prevLeader = doLeaderChangeTrait("merchant");
        for(tn = 0; tn < tradesToPerform; tn++){

            // Good to free up capacity (looking at you sharks)
            executeCrafts();
            tradeBtn.buttonContent.click()
        }
        executedPlan[tradeable] = executedTrades + tradesToPerform
        changeLeader(prevLeader);
    }
}

//#endregion

//#region Crafts

function getCrafts(){
    if(gamePage.workshopTab.visible)
        return gamePage.workshopTab.craftBtns.filter(b => b.model.visible && isFeasible(b));
    else
        return [gamePage.bldTab.children.find(btn => btn.model.name == "Refine catnip")];
}

function variableFromCraft(c){
    craft = c.craftName || 'wood'
    cv = {
        name: "Craft|" + craft
    };
    // TODO: If current manager has trait then effect is already factored in so needs to be removed.
    cv[craft] = -1 * (1 + game.getResCraftRatio(craft) + craftBonusForLeaderSwitch(craft) - currentLeaderCraftBonus(craft))
    for(price of c.model.prices){
        cv[price.name] = price.val;
    }
    if(craft == "wood" && game.bld.buildingsData.find(b => b.name == 'hut').val < 1){
        // We don't even have a hut yet, how quaint, we should do a little refining
        cv.utility = 1
    }
    // Mild bonus for unlock ziggurat
    else if(craft == "megalith" || craft == "scaffold"){ 
        if(!game.bld.get("ziggurat").unlocked && game.resPool.get(craft).value == 0){
            cv.utility = 0.01;
        }
    }
    // Ships are good ;-)
    else if(craft == "ship"){
        var baseutility = 5;
        var builtAlready = game.resPool.get("ship").value;
        cv.utility = baseutility - game.getLimitedDR(builtAlready, baseutility);
    } 
    /*
    // Manuscript max culture bonus (and may incentivize early temple)
    else if (craft == "manuscript") {
        cv.utility = 0.005 / game.resPool.get(craft).value
    } 
    // compendium max science bonus, nice typo in the craft name BTW
    else if (craft == "compedium") {
        cv.utility = 0.005 / game.resPool.get(craft).value
    }
    */
    return cv;
}

function executeCrafts(){
    craftButtons = getCrafts();
    for(craftable in plan) {
        if(!craftable.startsWith("Craft")){
            continue;
        }
        var craftLog = woodman.getLogger("main.Craft");
        alreadyDone = executedPlan[craftable] || 0;
        numDesiredRemaining = Math.ceil(plan[craftable] - alreadyDone);
        if(numDesiredRemaining < 1)
            continue;
        craftName = craftable.slice(6);
        //console.log(craftable, craftName, alreadyDone, numDesiredRemaining);
        btn = craftButtons.find(btn => (btn.opts.craft || "wood") == craftName);
        if(!btn){
            craftLog.warn("Couldn't locate craft button for ", craftName, ". WTF?");
            continue;
        }            
        numCanAfford = canAffordHowManyNow(btn);
        if(numCanAfford < 1)
            continue;
        numToActuallyCraft = Math.floor(Math.min(numCanAfford, numDesiredRemaining))
        if(numToActuallyCraft < 1)
            continue;
        
        var oldLeader = switchLeaderToCraft(craftName);
        craftLog.info("Crafting ", numToActuallyCraft, " ", craftName, " (", alreadyDone + numToActuallyCraft, "/", plan[craftable] ,")")
        executedPlan[craftable] = alreadyDone + numToActuallyCraft;
        game.workshop.craft(craftName, numToActuallyCraft)
        changeLeader(oldLeader);
    }
}

//#endregion

//#region Explore

function canUnlockRace(){
    // See diplomacy.js unlockRandomRace, ~ln 270
    // Is any of the "low requirement" 3 still locked
    if(gamePage.diplomacy.races.slice(0, 3).find(r => !r.unlocked))
        return true;
    var nagas = gamePage.diplomacy.get("nagas");
    if (!nagas.unlocked && game.resPool.get("culture").value >= 1500){
        return true;
    }
    var zebras = gamePage.diplomacy.get("zebras");
    if (!zebras.unlocked && game.resPool.get("ship").value >= 1){
        return true;
    }
    var spiders = gamePage.diplomacy.get("spiders");
    if (!spiders.unlocked && game.resPool.get("ship").value >= 100 && game.resPool.get("science").maxValue > 125000){
        return true;
    }
    var dragons = gamePage.diplomacy.get("dragons");
    if (!dragons.unlocked && game.science.get("nuclearFission").researched){
        return true;
    }
    return false;
}

function variableFromExplore() {
    gamePage.diplomacyTab.render();
    if(!gamePage.diplomacyTab.visible)
        return null;
    if(!isFeasible(gamePage.diplomacyTab.exploreBtn)) 
        return null; // Get some more kittens you pleb.
    if(!canUnlockRace())
        return null;
    return {
        name: "Explore",
        manpower: 1000,
        utility: 10
    };
}

function executeExplore() {
    gamePage.diplomacyTab.render();
    if(!gamePage.diplomacyTab.visible)
        return null;
    desiredExplore = (plan["Explore"] || 0);
    if(desiredExplore < 1)
        return;

    btn = gamePage.diplomacyTab.exploreBtn
    if(canAffordNow(gamePage.diplomacyTab.exploreBtn)){
        console.info("Exploring for new races!");
        btn.buttonContent.click();
        
        console.log("Replanning (explored)");
        planNow();
    }
}

//#endregion

//#region Hunts

function variableFromHunt(){
    if(!gamePage.villageTab.visible || !gamePage.villageTab.huntBtn.model.visible)
        return null;
    hunterRatio = game.getEffect("hunterRatio") + game.village.getEffectLeader("manager", 0);
    ivoryProb = (0.45 + 0.02 * hunterRatio) / 2;
    averageIvory = ivoryProb * (50 + (40 * hunterRatio));
    averageFurs = (80 + (65 * hunterRatio)) / 2;
    
    // There is some utility to having a few luxury resources floating about (about a season's worth buffer?).
    furRes = game.resPool.get('furs');
    ivoryRes = game.resPool.get('ivory');
    furCons = resoucePerTick(furRes, 0, null);
    ivoryCons = resoucePerTick(ivoryRes, 0, null);

    utilityForLux = 0
    if(projectResourceAmount(furRes) <= -1 * furCons * game.ticksPerSecond * planHorizonSeconds())
        utilityForLux += 0.05;
    if(projectResourceAmount(ivoryRes) <= -1 * ivoryCons * game.ticksPerSecond * planHorizonSeconds())
        utilityForLux += 0.05;
    // Sooo sparkly
    unicornResource = game.resPool.get('unicorns');
    if(unicornResource.value == 0)
        utilityForLux += 0.5;

    return {
        name: "Hunt",
        manpower: 100,
        unicorns: -0.05,
        ivory: -averageIvory,
        furs: -averageFurs,
        utility: utilityForLux
    };
}

function executeHunts() {
    desiredHunts = (plan["Hunt"] || 0);
    executedHunts = executedPlan["Hunt"] || 0;
    desiredRemainingHunts = desiredHunts - executedHunts;
    if(desiredHunts < 1)
        return;
    if(!gamePage.villageTab.visible || !gamePage.villageTab.huntBtn.model.visible)
        return;
    possibleHuntsNow = Math.floor(game.resPool.get("manpower").value / 100);
    if(possibleHuntsNow < 1)
        return;
    huntsToPerform = Math.min(desiredHunts, possibleHuntsNow)
    // console.info("Hunting ", huntsToPerform, huntsToPerform == possibleHuntsNow ? "  (as many as possible)" : ""," times (", executedHunts + huntsToPerform, "/", desiredHunts ,")")
    if(huntsToPerform == possibleHuntsNow){
        gamePage.village.huntAll()
    } else {
        for(i = 0; i < huntsToPerform; i++){
            gamePage.villageTab.huntBtn.buttonContent.click()
        }
    }
    executedPlan["Hunt"] = executedHunts + huntsToPerform;
}

//#endregion

//#region Incrementable Building

function getToggleableBuildings(){
    return gamePage.bld.buildingsData.filter(b => b.val > 0 && b.togglableOnOff);
}

//TODO: Bleurgh Steamworks are hard :-(
function variableFromToggleableBuilding(bld){
    bldId = buttonId(bld)
    bv = {
        name: "ToggleBuilding|" + bldId,
    };
    bv[bldId] = 1;
    return bv;
}

function getIncrementableBuildings(){
    return gamePage.bld.buildingsData.filter(b => b.val > 0 && b.togglable);
}

function variableFromIncrementableBuilding(bld){
    bldId = buttonId(bld)
    bv = {
        name: "IncrementBuilding|" + bldId,
    };
    bv[bldId] = 1;
    for(effect in bld.effectsCalculated){        
        //console.log(effect)
        if(! (effect.endsWith('PerTickAutoprod') || effect.endsWith('PerTickCon'))){
            //console.log("Ignoring effect ", effect, "(not production related)");
            continue;
        }
        if(bld.effectsCalculated[effect] == 0) {
            //console.log("Ignoring effect ", effect, "(zero value)");
            continue;
        }
        resName = effect.slice(0, effect.indexOf('PerTick'));        
        res = game.resPool.get(resName);
        //console.log(res)
        if(!res){
            log.warn(bld, " is claiming to make a resource ", resName, " I can't find ", bld)
            continue;
        }
        resRate = resoucePerTick(res, 2, bld);
        bv[resName] = -resRate * game.ticksPerSecond * planHorizonSeconds();
    }
    // TODO: Pollution
    return bv;
}

function filterHtmlCollection(collection, filterFn){
    var elems = []
    for(item of collection){
        if(filterFn(item))
            elems.push(item);
    }
    return elems;
}

function findHtmlCollection(collection, filterFn){
    for(var item of collection){
        if(filterFn(item))
            return item;
    }
    return null;
}

function executeToggleBuildings(){
    var blds = getIncrementableBuildings();
    for(toggleableBld of blds) {
        var desiredOn = plan["IncrementBuilding|" + toggleableBld.name] || 0;
        bldBtn = gamePage.bldTab.children.find(btn => btn.opts.building == toggleableBld.name)
        var currentlyOn = bldBtn.model.on;
        prob = desiredOn - Math.floor(desiredOn)
        if(Math.random() < prob)
            desiredOn = Math.ceil(desiredOn)
        else 
            desiredOn = Math.floor(desiredOn)
        if(currentlyOn == desiredOn)
            return;

        var onLinksDiv = findHtmlCollection(bldBtn.buttonContent.children, c => c.tagName == "DIV" && findHtmlCollection(c.children, anc => anc.tagName == "A" && anc.title == "+") != null)
        var offLinksDiv = findHtmlCollection(bldBtn.buttonContent.children, c => c.tagName == "DIV" && findHtmlCollection(c.children, anc => anc.tagName == "A" && anc.title == "-") != null)
        var onMultiDiv = findHtmlCollection(onLinksDiv.children, c => c.tagName == "DIV" && c.className == "linkContent")
        var offMultiDiv = findHtmlCollection(offLinksDiv.children, c => c.tagName == "DIV" && c.className == "linkContent")
        if(desiredOn == bldBtn.model.metadata.val){
            console.log("Firing up all ", toggleableBld.name)
            var onAllLink = findHtmlCollection(onMultiDiv.children, l => l.tagName == "A" && l.title == "+all")
            onAllLink.click();
            continue;
        }
        if(desiredOn == 0) {
            console.log("Power down all ", toggleableBld.name)
            var offAllLink = findHtmlCollection(offMultiDiv.children, l => l.tagName == "A" && l.title == "-all")
            offAllLink.click();
            continue;
        }
        console.log("Moderating number of ", toggleableBld.name, " to ", desiredOn, " from ", currentlyOn)
        if(currentlyOn > desiredOn){
            changeAmount = currentlyOn - desiredOn;
            singleLink = findHtmlCollection(offLinksDiv.children, l => l.tagName == "A")
            twentyFiveLink = findHtmlCollection(offMultiDiv.children, l => l.tagName == "A" && l.title == "-25")
        } else {
            changeAmount = desiredOn - currentlyOn; 
            singleLink = findHtmlCollection(onLinksDiv.children, l => l.tagName == "A")
            twentyFiveLink = findHtmlCollection(onMultiDiv.children, l => l.tagName == "A" && l.title == "+25")
        }
        while(changeAmount > 0){
            if(changeAmount > 25) {
                twentyFiveLink.click();
                changeAmount -= 25;
            }
            else {
                singleLink.click();
                changeAmount -= 1;
            }
        }
    }
}

//#endregion

//#region Simulate Production
function resoucePerTick(res, mode = 0, modeVariable = null) {
    //console.log("resoucePerTick(%s, %i, %s)", res.name, mode, buttonId(modeVariable))
    var productionStack = game.getResourcePerTickStack(res.name, false, game.calendar.season);
    return evaluateProductionStack(productionStack, res, mode, modeVariable)
}

/*
mode: 
0 / undefined - Non variable production
1 - Single villager production (modeVariable = job)
2 - Single building production (modeVariable = building)
3 - Steamworks  (modeVariable = Steamworks)
*/
function evaluateProductionStack(stack, resource, mode, modeVariable){
    var prod = 0.0;
    var lastMod = null;
    //console.log(stack)
    for(var resourceModifier of stack){
        //console.debug(prod, resourceModifier)
        if(resourceModifier instanceof(Array))
            prod += evaluateProductionStack(resourceModifier, resource, mode, modeVariable)
        // These are variable - we want to get production without these effects.
        else if(resourceModifier.name == '(:3) Village'){
            //console.log("village logic, mode ", mode)
            if(mode == 1){
                //console.log("adding one villager of production", modeVariable.modifiers, modeVariable.modifiers[resource.name])
                prod += (modeVariable.modifiers[resource.name] || 0) * gamePage.village.happiness
            } else {
                //console.log("ignoring village production")
                continue;
            }
        }
        else if (resourceModifier.name == 'Conversion Production' && lastMod == null){
            if(mode == 2)
                prod += (modeVariable.effectsCalculated[resource.name + "PerTickAutoprod"] || 0);
            else {            
                continue;
            }
        }
        // else if (resourceModifier.name == 'Conversion Production' && lastMod != null){
        //     if(mode == 3)
        //         prod += (modeVariable.effects[resource.name + "PerTickProd"] || 0) * steamBld.val;
        //     else {            
        //         continue;
        //     }
        // }
        else if (resourceModifier.name == 'Conversion Consumption'){
            if(mode == 2)
                prod += (modeVariable.effectsCalculated[resource.name + "PerTickCon"] || 0);
        }
        // else if (resourceModifier.name == 'Steamworks'){
        //     //console.log("Steamworks!?")
        //     if(mode == 3){
        //         prod *= 1 + (modeVariable.effects["coalRatioGlobal"] || 0)
        //     }
        // }
        // else if (resourceModifier.name == 'Magnetos'){
        //     var magRatio = 1 + game.getEffect("magnetoRatio");
        //     if(mode == 3){
        //         var swRatio = (1 + modeVariable.effects["magnetoBoostRatio"] * modeVariable.val);
        //         magRatio *= swRatio
        //     }
        //     prod *= magRatio;
        // }
        else if (resourceModifier.type == 'fixed') {
            if(mode == 0 || mode == 3)
                prod += resourceModifier.value;
            else 
                continue;
        }
        else if (resourceModifier.type == 'ratio')
            prod *= 1 + resourceModifier.value;
        //else
        //    console.warn("Didn't know how to include calculation of ", resourceModifier, " in evaluateProductionStackNonVariable.");
        lastMod = resourceModifier
    }
    return prod;
}

function projectResourceAmount(res) {
    var baseProduction = resoucePerTick(res, 0, null);
    var projected = res.value + (baseProduction * gamePage.ticksPerSecond * planHorizonSeconds());
    if(projected < 0)
        return 0;
    if(res.maxValue)
        return Math.min(projected, res.maxValue)
    else    
        return projected
}

// Reserve one season of nip
// TODO: reservedNipAmount is way too conservative. In spring we can reserve far far less for example.
function reservedNipAmount(){
    var nipDemandRatio = 1 + gamePage.globalEffectsCached.catnipDemandRatio;
    var ktns = gamePage.resPool.resourceMap["kittens"].value ;
    return ktns * nipDemandRatio * gamePage.village.happiness * 4 * 200 
}

//#endregion

//#region Include External Libraries

function includeSolver() {
    if (typeof solver !== 'undefined') {
        console.log("solver already included");
        return;
    }
    var xhttp = new XMLHttpRequest();
    xhttp.onreadystatechange = function() {
        if (this.readyState == 4 && this.status == 200) {
           eval(xhttp.responseText);
           console.log("lp solver downloaded and executed");
        }
    };
    xhttp.open("GET", "https://unpkg.com/javascript-lp-solver@0.4.24/prod/solver.js", true);
    xhttp.send();
}
includeSolver();

function includeLoglevel() {
    if (typeof woodman !== 'undefined') {
        logger.log("woodman already included");
        return;
    }
    var xhttp = new XMLHttpRequest();
    xhttp.onreadystatechange = function() {
        if (this.readyState == 4 && this.status == 200) {
           eval(xhttp.responseText);
           woodman.load('console');
           window.logger = woodman.getLogger('main');
           logger.level = "warn";
           logger.log("woodman downloaded and executed");
        }
    };
    xhttp.open("GET", "https://raw.githubusercontent.com/joshfire/woodman/master/dist/woodman.js", true);
    xhttp.send();
}
includeLoglevel();

//#endregion

// Get an identifiable id string for a button to tie solver together with buttons in ui
function buttonId(btn){
    if(btn.name)
        return btn.name;
    if(btn.race)
        return btn.race.name + "Embassy";
    if(btn.opts.building)
        return btn.opts.building;
    if(btn.opts.id)
        return btn.opts.id;
    return btn.opts.name;
}

//#region Leadership

// TODO: Make Leader a manager almost all the time and make this be the kitten that gets ranks.
// We will then swap to scientist / philosopher only when this enables an option to buy an upgrade (or plan to buy one).
// We already use artisan / chemist / mettalurgist exactly when needed, see executeCrafts.

// function canLeaderChangeMakeFeasible(trait){
//     if(!game.science.get("civil").researched)
//         return false;
//     outOfReach = getBuyables(false)
//     scienceMax = game.resPool.get("science").maxValue
//     for(infeasible of outOfReach) {

//     }
//     faithMax = game.resPool.get("faith").maxValue
// }


function civilServiceNotResearched(){
    return !game.science.get("civil").researched;
}

function kittenWithTrait(desiredTrait){
    if(civilServiceNotResearched())
        return null;
    return game.village.sim.kittens.find(k => k.trait && k.trait.name == desiredTrait);
}

// NB: Return old leader in case we need to undo the change
function doLeaderChangeTrait(desiredTrait){
    if(civilServiceNotResearched())
        return null;
    var previousLeader = game.village.leader
    changeLeader(kittenWithTrait(desiredTrait));
    return previousLeader;
}

function changeLeader(kitten){
    if(civilServiceNotResearched())
        return;
    if(!kitten)
        return;
    if(game.village.leader == kitten)
        return;
    //console.debug("Chaging leader to ", kitten.name, " ", kitten.surname, " (rank ", kitten.rank, kitten.trait ? kitten.trait.name : "", ")")
    game.villageTab.censusPanel.census.makeLeader(kitten);
}

function craftBonusForLeaderSwitch(craftName){
    for(desiredTrait of leaderDesiredTraitsFromCraft(craftName)){
        if(kittenWithTrait(desiredTrait.trait))
            return desiredTrait.bonus;
    }
    return 0;
}

function currentLeaderCraftBonus(craftName){
    if(civilServiceNotResearched())
        return 0;
    if(!game.village.leader)
        return 0;
    if(!game.village.leader.trait)
        return 0;
    for(desiredEffect of leaderDesiredTraitsFromCraft(craftName)){
        if(game.village.leader.trait.name == desiredEffect.trait)
            return desiredEffect.bonus;
    }
    return 0;
}

function tradeBonusForLeaderSwitch(){
    if(civilServiceNotResearched())
        return 0;
    if(game.village.leader && game.village.leader.trait && game.village.leader.trait.name == "merchant")
        return 0;
    var burnedParagonRatio = 1 + game.prestige.getBurnedParagonRatio();
    var leaderRatio = 1;
    if (game.science.getPolicy("monarchy").researched){
        leaderRatio = 1.95;
    }
    if(kittenWithTrait("merchant")) 
        return 0.03 * burnedParagonRatio * leaderRatio;
    return 0;
}

function switchLeaderToCraft(craftName){
    if(civilServiceNotResearched())
        return null;
        //console.debug("Attempting to switch leader to craft (so fickle)");
    for(var desiredTrait of leaderDesiredTraitsFromCraft(craftName)){
        // Do we already have leader with this trait?
        if(game.village.leader && game.village.leader.trait && game.village.leader.trait.name == desiredTrait.trait){
            //console.debug("Leader already has trait", desiredTrait.trait);
            return null;
        }
        var newLeader = kittenWithTrait(desiredTrait.trait)
        if(newLeader){
            prevLeader = game.village.leader;
            //console.debug("Switching from ", prevLeader, " to ", newLeader);
            changeLeader(newLeader);
            return prevLeader;
        } else {
            //console.debug("No kitten with trait", desiredTrait.trait);
        }
    }
    //console.debug("No kitten with any desirable trait");
    return null;
}

function leaderDesiredTraitsFromCraft(craftName){
    var burnedParagonRatio = 1 + game.prestige.getBurnedParagonRatio();
    var leaderRatio = 1;
    if (game.science.getPolicy("monarchy").researched){
        leaderRatio = 1.95;
    }
    switch(craftName){
        case "wood":
            return [];
        case "plate":
        case "steel":
        case "gear":
        case "alloy":
            return [{trait: "metallurgist", bonus: 0.1 * leaderRatio * burnedParagonRatio}, {trait: "engineer", bonus: 0.05 * leaderRatio * burnedParagonRatio}];
        case "concrete":
        case "eludium":
        case "kerosene":
        case "thorium":
            return [{trait: "chemist", bonus: 0.075 * leaderRatio * burnedParagonRatio}, {trait: "engineer", bonus: 0.05 * leaderRatio * burnedParagonRatio}];
        default: {
            var craftableResource = game.resPool.get(craftName);
            if(craftableResource.craftable)
                return [{trait: "engineer", bonus: 0.05 * leaderRatio * burnedParagonRatio}];
            else
                return [];
        }
    }
}

function kittenForPromotion() {
    var fnRankBy = (a, b) => { 
        var aIsManager = a.trait && a.trait.name == "manager";
        var bIsManager = b.trait && b.trait.name == "manager";
        if(aIsManager){
            if(bIsManager){
                if(a.rank > b.rank) 
                    return a; 
                else 
                    return b;
            } else {
                return a;
            }
        } else {
            if(bIsManager){
                return b;
            } else {
                if(a.rank > b.rank) 
                    return a; 
                else 
                    return b;
            }
        }
    };
    return game.village.sim.kittens.reduce(fnRankBy);
}

function variableForPromoteLeader(){
    if(civilServiceNotResearched())
        return null;
    var highRank = kittenForPromotion();
    var expToPromote = game.village.sim.expToPromote(highRank.rank, highRank.rank + 1, game.village.leader.exp)
    // Not much we can do about a lack of experience.
    if(!expToPromote[0])
        return null;
    // We just need to find out how much, hence assume infinite resource.
    var goldToPromote = game.village.sim.goldToPromote(highRank.rank, highRank.rank + 1, Infinity)
    return {
        name: "PromoteLeader",
        gold: goldToPromote[1],
        utility: 2
    };
}

function promoteUnderPlan(){
    if((plan.PromoteLeader || 0) < 1)
        return;
    if(executedPlan.PromoteLeader)
        return;
    if(civilServiceNotResearched())
        return null;
    var highRank = kittenForPromotion();
    var expToPromote = game.village.sim.expToPromote(highRank.rank, highRank.rank + 1, game.village.leader.exp);
    var goldToPromote = game.village.sim.goldToPromote(highRank.rank, highRank.rank + 1, game.resPool.get("gold").value);
    if (expToPromote[0] && goldToPromote[0]) {
        logger.log("Congrats to %s %s who was promoted from rank %i to %i", highRank.name, highRank.surname, highRank.rank, highRank.rank + 1)
        game.village.sim.promote(highRank);
        executedPlan.PromoteLeader = 1;
    }
}

function switchLeaderToBuy(btn){
    var leaderLog = woodman.getLogger("main.Leader");
    if(btn.model.prices.find(p => p.name == "faith")){
        return doLeaderChangeTrait("wise")
    }
    else if(btn.tab && (btn.tab.tabId == "Science" || btn.tab.tabId == "Workshop")){
        return doLeaderChangeTrait("scientist")
    }
    return null;
}

function desiredTraitToBuy(btn){
    if(btn.model.prices.find(p => p.name == "faith"))
        return "wise";
    else if (btn.tab && (btn.tab.tabId == "Science" || btn.tab.tabId == "Workshop"))
        return "scientist";
    return null;
}

function canSwapLeaderToPurchase(btn, feasibilityStudy = true){
    var leaderLog = woodman.getLogger("main.Leader");
    var limitingFactors = limitedResources(btn);
    if(limitingFactors.length == 0)
        return null;
    // Religion Upgrade
    var burnedParagonRatio = 1 + game.prestige.getBurnedParagonRatio();
    var leaderRatio = 1;
    if (game.science.getPolicy("monarchy").researched){
        leaderRatio = 1.95;
    }
    if(btn.model.prices.find(p => p.name == "faith")){
        // Current leader is already wise. swapping doesn't help.
        if(game.village.leader && game.village.leader.trait && game.village.leader.trait.name == "wise")
            return null;    
        // No wise kitten to swap to.
        if(!kittenWithTrait("wise"))
            return null;
        var reductionRatio = game.getLimitedDR((0.09 + 0.01 * burnedParagonRatio) * leaderRatio, 1.0); 
        for(var factor of limitingFactors){
            // Wisdom only helps with faith and gold.
            if(! (factor.name == "faith" || factor.name == "gold")){
                //leaderLog.log("needs non faith / gold resource");
                return null;
            }
            var limRes = game.resPool.get(factor.name);
            var resourceValue = feasibilityStudy ? limRes.maxValue : limRes.value;
            //leaderLog.log("%s needed %i, resourceValue %i, reductionFactor %f, amountNeededWithReduction %f", factor.name, factor.val, resourceValue, reductionRatio, factor.val * (1 - reductionRatio));
            if(resourceValue < factor.val * (1 - reductionRatio)){
                // Still over max with swap.
                //leaderLog.log("%s still over max with swap have %i, needed %i", limRes.name, factor.val * (1 - reductionRatio), resourceValue);
                return null;
            }
        }
        // Looks like a leader swap helps!
        //leaderLog.log("wisdom helps here",);
        return "wise";
    }
    // Library / Workshop can discount science upgrades.
    else if(btn.tab && (btn.tab.tabId == "Science" || btn.tab.tabId == "Workshop"))
    {
        //leaderLog.log("Evaluating canSwapLeaderToPurchase for %s", buttonId(btn));
        // Current leader is already wise. swapping doesn't help.
        if(game.village.leader && game.village.leader.trait && game.village.leader.trait.name == "scientist")
            return null;    
        //leaderLog.log("Leader is not yet scientist");
        // No sciencey kitten to swap to.
        if(!kittenWithTrait("scientist"))
            return null;
        //leaderLog.log("Yes we have a scientist");
        // We can only help science.
        if(limitingFactors.length > 1 || limitingFactors[0].name != "science")
            return null;
        //leaderLog.log("We only need to help science");
        var factor = limitingFactors[0];
        var limRes = game.resPool.get(factor.name);
        var resourceValue = feasibilityStudy ? limRes.maxValue : limRes.value;
        var reductionRatio = game.getLimitedDR(0.05 * burnedParagonRatio  * leaderRatio, 1.0); //5% before BP
        
        //leaderLog.log("Science needed %i, resourceValue %i, reductionFactor %f, amountNeededWithReduction %f", factor.val, resourceValue, reductionRatio, factor.val * (1 - reductionRatio));

        if(resourceValue > factor.val * (1 - reductionRatio)){
            //leaderLog.log("science helps here");
            return "scientist"
        } else {
            // Still over max with swap.
            //leaderLog.log("Still over max with swap");
            return null;
        }
    }
    // Nothing else can be discounted.
    return null;
}

function leaderDiscountRatio(btn, resName){
    var burnedParagonRatio = 1 + this.game.prestige.getBurnedParagonRatio();
    var leaderRatio = 1;
    if (this.game.science.getPolicy("monarchy").researched){
        leaderRatio = 1.95;
    }
    if(btn.tab && (btn.tab.id == "Workshop" && btn.tab.id == "Science") && resName == "science" && kittenWithTrait("scientist")) {
        return 1 - (game.getLimitedDR(0.05 * burnedParagonRatio  * leaderRatio, 1.0));
    } else if(game.religion.religionUpgrades.find(ru => ru.name == btn.model.metadata.name) && (resName == "faith" || resName == "gold") && kittenWithTrait("wise")) {
        return 1 - (game.getLimitedDR((0.09 + 0.01 * burnedParagonRatio) * leaderRatio, 1.0));
    } else {
        return 1;
    }
}

//#endregion

//#region Faith

function variableForPraiseSun(){
    if(!gamePage.religionTab.visible)
        return null;
    gamePage.religionTab.render();
    var halfFaith = game.resPool.get("faith").maxValue / 2;
    // What a crumbily named variable :-(. Hysterical raisins I suppose.
    var worship = game.religion.faith;
    var nextUnlockBtn = gamePage.religionTab.rUpgradeButtons.find(ru => !ru.model.visible);
    var revolutionBtn = gamePage.religionTab.rUpgradeButtons.find(ru => ru.id == "solarRevolution");
    // Utility for unlocking another option to work towards.
    var worshipToUnlockNextOption = nextUnlockBtn ? nextUnlockBtn.model.metadata.faith - worship: -1;
    var howFarDoesPraiseGetUs = Math.min(1, halfFaith / worshipToUnlockNextOption);
    var utility = nextUnlockBtn ? howFarDoesPraiseGetUs : 0;
    if(revolutionBtn.model.metadata.val > 0){
        // TODO: Boost utility for gathering worship if we have solar revolution.
    }
    return {
        name: "PraiseTheSun",
        faith: halfFaith,
        utility: utility
    }
}

function praiseUnderPlan(){
    if(!plan)
        return;
    var plannedPraise = Math.floor(plan["PraiseTheSun"] || 0);
    var praiseToDo = plannedPraise - (executedPlan["PraiseTheSun"] || 0);
    if(praiseToDo <= 0)
        return;
    var faithAmount = game.resPool.get("faith").value;
    var halfFaith = game.resPool.get("faith").maxValue / 2;
    var praisesAvailable = faithAmount / halfFaith;
    //console.log("praiseToDo: %i, faithAmount: %i, halfFaith: %i, praisesAvailable: %i", praiseToDo, faithAmount, halfFaith, praisesAvailable);
    if(praisesAvailable > 1){
        console.log("About to paise %i ", praisesAvailable);
        gamePage.religionTab.praiseBtn.buttonContent.click();
        executedPlan.PraiseTheSun = (executedPlan.PraiseTheSun || 0) + praisesAvailable;
    }
}

function variableForSacrifice(){
    if(!gamePage.religionTab.visible)
        return null;
    var zigs = game.bld.get("ziggurat").val;
    if(game.bld.get("ziggurat").val == 0)
        return null;
    var su = {
        name: "SacrificeUnicorns",
        unicorns: 2500,
        tears: -zigs
    }
    // Tears are a luxury.
    if(game.resPool.get("tears").value == 0)
        su.utility = 0.5;
    return su;
}

function sacrificeUnderPlan(){
    if(!plan)
        return;
    if(!gamePage.religionTab.visible)
        return null;
    if(game.bld.get("ziggurat").val == 0)
        return null;
    var executedSacs = executedPlan["SacrificeUnicorns"] || 0;
    var plannedSac = Math.floor(plan["SacrificeUnicorns"] || 0);
    var sacsDesired = plannedSac - executedSacs;
    var sacsPossible = Math.floor(game.resPool.get("unicorns").value / 2500.0);
    var sacsToDo = Math.min(sacsPossible, sacsDesired)
    if(sacsToDo <= 0)
        return;
    for(var i = 0; i < sacsToDo; i++){
        gamePage.religionTab.sacrificeBtn.buttonContent.click()
    }
    executedPlan["SacrificeUnicorns"] = executedSacs + sacsToDo;
}

//#endregion