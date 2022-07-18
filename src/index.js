// import * as core from "@actions/core";
// import * as github from "@actions/github";
// import * as semver from "semver";

const core   = require("@actions/core");
const github = require("@actions/github");
const semver = require("semver");

/**
 * load the configuration and parameters for the action.
 *
 * This function will handle defaults and parameter validation to ensure
 * that the action preparation has completed properly.
 *
 * @returns params
 */
function getParameters() {
    const params = {};

    const Parameters = [
        "branch",
        "bump",
        "dry-run",
        "force",
        "github-token",
        "issue-labels" ,
        "release-branch",
        "style",
        "tag",
        "version-prefix",
        "with-v"
    ];

    const Styles = [
        "semver",
        "date",
        "datetime",
        "dotdate",
        "dotdatetime",
        "isodate",
        "isodatetime"
    ];

    // helper for direct value remapping
    const Remap = {
        "github-token": "token",
        "issue-labels": "labels",
        "release-branch": "releaseBranch",
        "version-prefix": "prefix"
    };

    Parameters.forEach((pname) => params[pname] = core.getInput(pname));
    Object.keys(Remap).forEach((pname) => params[Remap[pname]] = params[pname]);

    // fix complex parameters
    params["dryRun"] = params["dry-run"].toLowerCase() !== "false";
    params["force"] = params["force"].toLowerCase() !== "false";
    params["withV"]  = params["with-v"].toLowerCase() === "false" ? "" : params.prefix;

    params["style"] = Styles.includes(params["style"]) ? params["style"] :  "semver";

    // ensure that everything is fine if the user passed an empty list
    params.issueLabels = params.labels.split(",").map(label => label.trim());

    if (!params.issueLabels.length) {
        params.issueLabels = ["enhancement"];
    }

    // set the date tag as forced tag, if set by style
    const dateTag = getDateStyle(params.style);

    params.tag = dateTag === "" ? params.tag : dateTag;

    return params;
}

/**
 * creates a date-version string for the current date (and time).
 *
 * This function handles the following styles:
 * - date (reverse date)
 * - datetime (reverse timestamp)
 * - isodate (iso-style date)
 * - isodatetime (iso-style timestamp. replaces colons and dots to dashes)
 * - dotdate (semver style dates)
 * - dotdatetime (semver style timestamp, down to a minute)
 *
 * @param {String} style
 * @returns dateVersion
 */
function getDateStyle(style) {
    if (! style.match(/date/) ) {
        return "";
    }

    const now = new Date();

    if (style.match(/iso/)) {
        const cleanup = style.match(/datetime/) ? /-\d\d\.\d+Z$/ : /T.+$/;

        return now.toISOString().replace(/:/g,"-").replace(cleanup, "");
    }

    let seperator = "";
    let date = [now.getFullYear(), now.getMonth(), now.getDay()];

    if (style.match(/dot/)) {
        seperator = ".";
    }

    if (style.match(/datetime/)) {
        date = date.concat([now.getHour(), now.getMinute()]);
    }

    return date.join(seperator);
}

/**
 * Verifies that the new tag does not already exist.
 *
 * @param {Array(String)} tagList
 * @param {String} tagName
 * @returns bool
 */
async function checkTag(tagList, tagName) {
    const result = tagList.filter(tag => tag.name === tagName);

    return result.length > 0;
}

/**
 * Fetches all tags for the active repository
 *
 * @param {octokit} context - the github context
 * @returns tagList
 */
async function getAllTags(context) {
    const { data } = await context.octokit.rest.repos.listTags({
        owner: context.owner,
        repo: context.repo
    });

    const allVTags = data
        .map(tag => tag.name = semver.clean(tag.name))
        .filter(tag => tag.name !== null)
        .sort((a,b) => semver.compare(a.name, b.name));

    // FIXME: filter tags only relevant for the current branch (Issue 155)

    return allVTags;
}

/**
 * drops all prerelease tags from the tag list.
 *
 * @param {Array(String)} tagList
 * @returns cleanedTagList
 */
function dropPreReleaseTags(tagList) {
    return tagList.filter((tag) => semver.prerelease(tag.name) === null);
}

/**
 * loads an external branch if needed.
 *
 * @param {*} context
 * @param {*} branch
 * @returns branchContext
 */
async function loadBranch(context, branch) {
    const result = await context.octokit.rest.git.listMatchingRefs({
        owner: context.owner,
        repo: context.repo,
        ref: `heads/${branch}`
    });

    // core.info(`branch data: ${ JSON.stringify(result.data, undefined, 2) } `);
    return result.data.shift();
}

/**
 * Fetches the lables of an issue.
 *
 * @param {*} context - the GH context
 * @param {Number} issue_number - the issue number
 * @returns list of labels for the issue
 */
async function getIssueLabel(context, issue_number) {
    const { data } = await context.octokit.rest.issues.get({
        owner: context.owner,
        repo: context.repo,
        issue_number
    });

    return data ? data.labels : [];
}

/**
 * returns the bump level according to one commit message
 *
 * This function is used by the map-reduce logic.
 *
 * @param {*} message - the commit  message
 * @returns bumpLevel
 */
async function messageToBumpLevel(message) {
    const wip   = new RegExp(/#wip\b/);
    const major = new RegExp(/#major\b/);
    const minor = new RegExp(/#minor\b/);
    const issue = new RegExp(/fix(?:es)? #(\d+)\b/);

    if (wip.test(message)) {
        // this will stop the tagging.
        return "none";
    }
    if (major.test(message)) {
        return "major";
    }
    if (minor.test(message)) {
        return "minor";
    }

    const id = issue.exec(message);

    if (id && Number(id[1]) > 0) {
        return id[1];
    }

    return "patch";
}

/**
 * Determines the bump level according to issues and commit messages
 *
 * @param {*} parameters - the action config
 * @param {*} context - the GH Context
 * @param {*} tagSha - refers to the previously tagged commit
 * @returns finalBumpLevel
 */
async function checkMessages(parameters, context, tagSha) {
    const issueLabels = parameters.issueLabels;

    // core.info(`load commits since ${sha}`);
    const result = await context.octokit.rest.repos.listCommits({
        owner: context.owner,
        repo: context.repo,
        sha: tagSha
    });

    if (!(result && result.data)) {
        // nothing to do
        return "none";
    }

    const levels = result.data
        .map((commit) => messageToBumpLevel(commit.message));

    if (levels.includes("major")) {
        return "major";
    }
    if (levels.includes("minor")) {
        return "minor";
    }

    const testlevels = ["major", "minor", "patch"];
    const issues = levels
        .filter(bl => !testlevels.includes(bl));

    if (issues.length) {
        for (const issue of issues)  {
            const label = await getIssueLabel(context, issue);

            if (issueLabels.includes(label)) {
                core.info("found enhancement issue");
                return "minor";
            }
        }
        return "patch";
    }

    if (levels.includes("patch")) {
        return "patch";
    }

    // we found only work in progress tags
    return "none";
}

/**
 * check if the current branch is in fact a release branch
 *
 * if the current branch is not set for releases avoid tagging.
 *
 * @param {*} currentBranch
 * @param {*} allowedBranches
 * @returns boolean
 */
function isReleaseBranch(currentBranch, allowedBranches) {
    // this algorithm accepts a few extra iterations for the sake of simplicity
    const isReleasable = allowedBranches
        .split(",")
        .map(b => new RegExp(b.trim()).test(currentBranch))
        .filter(e => e);

    return isReleasable.length > 0; // note that more than one patter may match a specific branch.
}

/**
 * verify whether a custom branch exists
 *
 * @param {*} parameters - action parameters
 * @param {*} context - gh action contexts
 * @returns branchInfo
 */
async function verifyBranch(parameters, context) {

    const forcedBranch = parameters.branch && parameters.branch.length;
    const branch = forcedBranch ? parameters.branch.trim() : context.ref.replace(/refs\/heads\//, "");

    core.info(`check forced branch ${branch}`);

    const branchInfo = await loadBranch(context.octokit, context.ref, branch);

    if (!branchInfo) {
        throw new Error(`unknown ${ forcedBranch ? "forced " : "" }branch ${branch} provided`);
    }

    return branchInfo;
}

/**
 * dryRun helpe that does nothing but reporting that the action runs in dryRun mode.
 *
 * @param {*} context - ghcontext for API conformance
 * @param {*} tag - the tag to apply foro API conformance
 */
async function applyDry(context, tag) {
    core.info(`Dry run. Do not apply ${tag} to ${context.repo}`);
}

/**
 * applies a new tag to the current HEAD
 *
 * @param {*} context - ghcontext for API conformance
 * @param {*} tag - the tag to apply foro API conformance
 * @returns nothing
 */
async function applyTag(context, tag) {
    if (!tag || tag === "") {
        core.info("No tag to apply");
        return;
    }

    core.info(`apply new tag ${ tag } to ${ context.repo }`);

    const ref = `refs/tags/${ tag }`;

    await context.octokit.rest.git.createRef({
        owner: context.owner,
        repo: context.repo,
        ref: ref,
        sha: context.sha
    });
}

/**
 * verify that a given tag does not already exist in the repo
 *
 * @param {*} parameters
 * @param {*} context
 * @param {*} tagList
 * @returns newTag
 */
async function checkStatic(parameters, context, tagList) {
    const newTag = parameters.tag;

    const doesTagExist = checkTag(tagList, newTag);

    if (doesTagExist) {
        core.info(`tag already exists ${newTag} in ${ context.repo }`);

        if (!parameters.force) {
            return "";
        }
    }

    return newTag;
}

/**
 * find and check a new semver tag.
 *
 * @param {*} parameters - action config parameters
 * @param {*} context - gh context
 * @param {*} tagList - the repos tags
 * @returns newTag
 */
async function checkSemver(parameters, context, tagList) {
    core.info(`check semver tags before ref: ${ context.sha }`);

    const latestTag = tagList.pop();
    const latestMainTag = dropPreReleaseTags(tagList).pop();

    core.info(`the previous tag of the repository ${ JSON.stringify(latestTag, undefined, 2) }`);
    core.info(`the previous main tag of the repository ${ JSON.stringify(latestMainTag, undefined, 2) }`);

    core.setOutput("tag", versionTag);

    if (latestTag && latestTag.commit.sha === context.sha) {
        core.info("no new commits, avoid tagging");
        return "";
    }

    core.info(`The repo tags: ${ JSON.stringify(latestTag, undefined, 2) }`);

    const versionTag    = latestTag && latestTag.name ? latestTag.name : "0.0.0";
    const versionSemver = semver.clean(versionTag);

    // check if commits and issues point to a diffent release level
    // This filters hash tags for major, minor, patch and wip commit messages.
    core.info("check commits in branch");

    const bumpLevel = await checkMessages(
        parameters,
        context,
        latestMainTag ? latestMainTag.commit.sha : "", // terminate at the previous tag or at the initial commit
    );

    if (bumpLevel === "none") {
        core.info("no commit messages or work in progress found, avoid tagging");
        return "";
    }

    core.info(`commit messages force bump level to ${ bumpLevel }`);

    // major changes may ooccur between prereleases. In these cases the version number of the release will change.
    let nextVersion = semver.inc(versionSemver, bumpLevel);

    if (!isReleaseBranch(context.branchName, parameters.releaseBranch)) {
        core.info(`${ context.branchName } is not a release branch, create a prelease tag`);

        // find the latest tag on the same major release
        // increase the prerelease number
        nextVersion = semver.inc(nextVersion, "prerelease", context.branchName);
    }

    core.info( `bump tag to ${ nextVersion }` );

    // finally we want too verify that the tag does not exist already
    // IMPORTANT: Dont attach the new tag to parameters.tag because of possible side effects!
    return checkStatic({tag: nextVersion, force: parameters.force}, context, tagList);
}

/**
 * choses the tagging handlers depending on the requested tagging style
 *
 * This factory function returns an Object with two callback functions.
 *
 * - checkFunction - this checks and generates a new version tag.
 * - applyFunction - this applies the new version tag if needed.
 *
 * The logic of this handler is to simplify the main action's logic to a pure functional approach.
 * This function encapsulates the action's parameters and the context, so the main function just
 * passes the dynamic parts to the function.
 *
 * @param {*} parameters - the actions config
 * @param {*} context - github context
 * @returns taggingTandlers
 */
function chooseTaggingStyle(parameters, context) {

    // parameters.tag holds a custom tag that overrides the tagging style
    // if the tagging style is not semver, we also use the static versioning
    const checkFunction = parameters.tag || parameters.style !== "semver" ? checkStatic : checkSemver;
    const applyFunction = parameters.dryRun ? applyDry : applyTag;

    return {
        nextVersion: (taglist) => checkFunction(parameters, context, taglist),
        apply: (newVersionTag) => applyFunction(context, newVersionTag)
    };
}

/**
 * unused?
 *
 * @param {*} ghContext
 * @param {*} config - the actions config
 */
function setupContext(ghContext, config) {
    const context = {};

    context.owner = ghContext.context.payload.repository.owner.login;
    context.repo  = ghContext.context.payload.repository.name;
    context.ref   = ghContext.context.ref;

    context.octokit = new ghContext.getOctokit(config.token);
}

/**
 * the action's main function.
 *
 * @returns nothing
 */
async function action() {
    const parameters = getParameters();
    const context = setupContext(github.context, parameters);

    core.info(`run for ${ context.owner } / ${ context.repo }`);

    // check whether the versioning branch exists
    const branchInfo = await verifyBranch(parameters, context);

    if (!branchInfo) {
        return;
    }

    core.info("branch confirmed, continue");

    // extract commit infos of the active context
    context.sha        = branchInfo.object.sha;
    context.branchName = branchInfo.ref.split("/").pop();

    core.info(`active branch name is ${ context.branchName }`);

    const handler = chooseTaggingStyle(parameters, context);

    const tagList     = await getAllTags(context);
    const nextVersion = await handler.nextVersion(tagList);

    core.setOutput("new-tag", nextVersion);

    await handler.apply(nextVersion);
}

action()
    .then(() => core.info("success"))
    .catch(error => core.setFailed(error.message));
