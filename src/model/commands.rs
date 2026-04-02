//! Slash commands for Claude Code sessions
//!
//! This module provides the list of available slash commands that can be
//! executed within a Claude Code session, including dynamic skill discovery.

use std::fs;
use std::path::Path;

use super::types::SlashCommand;

/// Returns the list of static slash commands
///
/// These commands are static and known at compile time. They represent
/// the built-in commands available in Claude Code CLI.
pub fn list_commands() -> Vec<SlashCommand> {
    vec![
        SlashCommand {
            name: "/compact".to_string(),
            description: "Compact conversation to save context".to_string(),
            usage: "/compact".to_string(),
            has_args: false,
        },
        SlashCommand {
            name: "/clear".to_string(),
            description: "Clear conversation history".to_string(),
            usage: "/clear".to_string(),
            has_args: false,
        },
        SlashCommand {
            name: "/help".to_string(),
            description: "Show available commands".to_string(),
            usage: "/help".to_string(),
            has_args: false,
        },
        SlashCommand {
            name: "/model".to_string(),
            description: "Change the model".to_string(),
            usage: "/model <model-name>".to_string(),
            has_args: true,
        },
        SlashCommand {
            name: "/config".to_string(),
            description: "View or modify configuration".to_string(),
            usage: "/config [key] [value]".to_string(),
            has_args: true,
        },
        SlashCommand {
            name: "/cost".to_string(),
            description: "Show token and cost usage".to_string(),
            usage: "/cost".to_string(),
            has_args: false,
        },
        SlashCommand {
            name: "/doctor".to_string(),
            description: "Health check Claude Code installation".to_string(),
            usage: "/doctor".to_string(),
            has_args: false,
        },
        SlashCommand {
            name: "/review".to_string(),
            description: "Review recent changes".to_string(),
            usage: "/review".to_string(),
            has_args: false,
        },
        SlashCommand {
            name: "/init".to_string(),
            description: "Initialize project settings".to_string(),
            usage: "/init".to_string(),
            has_args: false,
        },
        SlashCommand {
            name: "/memory".to_string(),
            description: "Edit CLAUDE.md memory file".to_string(),
            usage: "/memory".to_string(),
            has_args: false,
        },
        // New commands
        SlashCommand {
            name: "/plan".to_string(),
            description: "Create an implementation plan".to_string(),
            usage: "/plan <task description>".to_string(),
            has_args: true,
        },
        SlashCommand {
            name: "/add-dir".to_string(),
            description: "Add a directory to context".to_string(),
            usage: "/add-dir <path>".to_string(),
            has_args: true,
        },
        SlashCommand {
            name: "/context".to_string(),
            description: "Show current context window usage".to_string(),
            usage: "/context".to_string(),
            has_args: false,
        },
        SlashCommand {
            name: "/rewind".to_string(),
            description: "Rewind conversation to a previous point".to_string(),
            usage: "/rewind [steps]".to_string(),
            has_args: true,
        },
        SlashCommand {
            name: "/tasks".to_string(),
            description: "List or manage background tasks".to_string(),
            usage: "/tasks [list|cancel <id>]".to_string(),
            has_args: true,
        },
        SlashCommand {
            name: "/export".to_string(),
            description: "Export conversation to file".to_string(),
            usage: "/export [format]".to_string(),
            has_args: true,
        },
        SlashCommand {
            name: "/mcp".to_string(),
            description: "Manage MCP server connections".to_string(),
            usage: "/mcp [list|connect|disconnect]".to_string(),
            has_args: true,
        },
        SlashCommand {
            name: "/plugin".to_string(),
            description: "Manage plugins".to_string(),
            usage: "/plugin [list|enable|disable]".to_string(),
            has_args: true,
        },
        SlashCommand {
            name: "/theme".to_string(),
            description: "Change terminal theme".to_string(),
            usage: "/theme [name]".to_string(),
            has_args: true,
        },
        SlashCommand {
            name: "/output-style".to_string(),
            description: "Change output format style".to_string(),
            usage: "/output-style [compact|verbose|json]".to_string(),
            has_args: true,
        },
        SlashCommand {
            name: "/vim".to_string(),
            description: "Toggle vim mode".to_string(),
            usage: "/vim [on|off]".to_string(),
            has_args: true,
        },
        SlashCommand {
            name: "/report-bug".to_string(),
            description: "Report a bug to the team".to_string(),
            usage: "/report-bug".to_string(),
            has_args: false,
        },
    ]
}

/// Parse YAML frontmatter from a SKILL.md file
///
/// Returns (name, description, user_invocable) if valid frontmatter found.
fn parse_skill_frontmatter(content: &str) -> Option<(String, String, bool)> {
    // Check for frontmatter markers
    if !content.starts_with("---") {
        return None;
    }

    // Find the end of frontmatter
    let rest = &content[3..];
    let end_idx = rest.find("---")?;
    let frontmatter = &rest[..end_idx];

    let mut name = None;
    let mut description = None;
    let mut user_invocable = false;

    for line in frontmatter.lines() {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("name:") {
            name = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("description:") {
            description = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("user-invocable:") {
            user_invocable = value.trim() == "true";
        }
    }

    match (name, description) {
        (Some(n), Some(d)) => Some((n, d, user_invocable)),
        _ => None,
    }
}

/// Extract skill name and description from a SKILL.md without frontmatter.
///
/// Falls back to using the parent directory name as the command name
/// and the first markdown heading or non-empty line as the description.
fn parse_skill_without_frontmatter(content: &str, dir_name: &str) -> Option<(String, String)> {
    let name = format!("/{}", dir_name);
    let mut description = String::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }
        // Use first heading text as description
        if let Some(heading) = trimmed.strip_prefix('#') {
            description = heading.trim_start_matches('#').trim().to_string();
            break;
        }
        // Or first non-empty line
        description = trimmed.to_string();
        break;
    }

    if description.is_empty() {
        description = dir_name.to_string();
    }

    Some((name, description))
}

/// Discover skills from a project folder's .claude/skills directory
///
/// Scans for SKILL.md files and parses their frontmatter to extract
/// user-invocable skills as slash commands. Skills without frontmatter
/// are also included using the directory name as the command name.
pub fn discover_skills(folder: &str) -> Vec<SlashCommand> {
    let skills_dir = Path::new(folder).join(".claude").join("skills");

    if !skills_dir.exists() || !skills_dir.is_dir() {
        return Vec::new();
    }

    let mut skills = Vec::new();

    // Read the skills directory
    let entries = match fs::read_dir(&skills_dir) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };

    for entry in entries.flatten() {
        let path = entry.path();

        // Skip non-directories
        if !path.is_dir() {
            continue;
        }

        let skill_file = path.join("SKILL.md");
        if !skill_file.exists() {
            continue;
        }

        // Read and parse the SKILL.md file
        let content = match fs::read_to_string(&skill_file) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let dir_name = path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("skill")
            .to_string();

        if let Some((name, description, user_invocable)) = parse_skill_frontmatter(&content) {
            // Skills with frontmatter: only include if user-invocable
            if user_invocable {
                skills.push(SlashCommand {
                    name: format!("/{}", name),
                    description,
                    usage: format!("/{}", name),
                    has_args: false,
                });
            }
        } else if let Some((name, description)) = parse_skill_without_frontmatter(&content, &dir_name) {
            // Skills without frontmatter: include by default (directory name = command name)
            skills.push(SlashCommand {
                name: name.clone(),
                description,
                usage: name,
                has_args: true, // Assume skills accept args
            });
        }
    }

    // Sort by name for consistent ordering
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

/// List all commands including discovered skills from a project folder
///
/// Combines static commands with dynamically discovered skills.
pub fn list_commands_with_skills(folder: &str) -> Vec<SlashCommand> {
    let mut commands = list_commands();
    let skills = discover_skills(folder);

    // Append skills (they already have the / prefix)
    commands.extend(skills);

    commands
}

// =============================================================================
// Unit Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_list_commands_returns_all_commands() {
        let commands = list_commands();
        assert_eq!(commands.len(), 22); // 10 original + 12 new
    }

    #[test]
    fn test_list_commands_includes_expected() {
        let commands = list_commands();
        let names: Vec<&str> = commands.iter().map(|c| c.name.as_str()).collect();

        // Original commands (with / prefix now)
        assert!(names.contains(&"/compact"));
        assert!(names.contains(&"/clear"));
        assert!(names.contains(&"/help"));
        assert!(names.contains(&"/model"));
        assert!(names.contains(&"/config"));
        assert!(names.contains(&"/cost"));
        assert!(names.contains(&"/doctor"));
        assert!(names.contains(&"/review"));
        assert!(names.contains(&"/init"));
        assert!(names.contains(&"/memory"));

        // New commands
        assert!(names.contains(&"/plan"));
        assert!(names.contains(&"/add-dir"));
        assert!(names.contains(&"/context"));
        assert!(names.contains(&"/rewind"));
        assert!(names.contains(&"/tasks"));
        assert!(names.contains(&"/export"));
        assert!(names.contains(&"/mcp"));
        assert!(names.contains(&"/plugin"));
        assert!(names.contains(&"/theme"));
        assert!(names.contains(&"/output-style"));
        assert!(names.contains(&"/vim"));
        assert!(names.contains(&"/report-bug"));
    }

    #[test]
    fn test_commands_with_args() {
        let commands = list_commands();

        let model_cmd = commands.iter().find(|c| c.name == "/model").unwrap();
        assert!(model_cmd.has_args);

        let config_cmd = commands.iter().find(|c| c.name == "/config").unwrap();
        assert!(config_cmd.has_args);

        let plan_cmd = commands.iter().find(|c| c.name == "/plan").unwrap();
        assert!(plan_cmd.has_args);
    }

    #[test]
    fn test_commands_without_args() {
        let commands = list_commands();

        let compact_cmd = commands.iter().find(|c| c.name == "/compact").unwrap();
        assert!(!compact_cmd.has_args);

        let clear_cmd = commands.iter().find(|c| c.name == "/clear").unwrap();
        assert!(!clear_cmd.has_args);

        let report_bug_cmd = commands.iter().find(|c| c.name == "/report-bug").unwrap();
        assert!(!report_bug_cmd.has_args);
    }

    #[test]
    fn test_command_fields_populated() {
        let commands = list_commands();

        for cmd in commands {
            assert!(!cmd.name.is_empty(), "Command name should not be empty");
            assert!(
                cmd.name.starts_with('/'),
                "Command name should start with slash"
            );
            assert!(
                !cmd.description.is_empty(),
                "Command description should not be empty"
            );
            assert!(!cmd.usage.is_empty(), "Command usage should not be empty");
            assert!(
                cmd.usage.starts_with('/'),
                "Usage should start with slash"
            );
        }
    }

    #[test]
    fn test_parse_skill_frontmatter_valid() {
        let content = r#"---
name: audit
description: Run review agents
user-invocable: true
---
# Audit Skill
"#;
        let result = parse_skill_frontmatter(content);
        assert!(result.is_some());
        let (name, desc, invocable) = result.unwrap();
        assert_eq!(name, "audit");
        assert_eq!(desc, "Run review agents");
        assert!(invocable);
    }

    #[test]
    fn test_parse_skill_frontmatter_not_invocable() {
        let content = r#"---
name: internal
description: Internal skill
user-invocable: false
---
"#;
        let result = parse_skill_frontmatter(content);
        assert!(result.is_some());
        let (name, _, invocable) = result.unwrap();
        assert_eq!(name, "internal");
        assert!(!invocable);
    }

    #[test]
    fn test_parse_skill_frontmatter_no_frontmatter() {
        let content = "# Just markdown";
        assert!(parse_skill_frontmatter(content).is_none());
    }

    #[test]
    fn test_parse_skill_frontmatter_missing_fields() {
        let content = r#"---
name: incomplete
---
"#;
        assert!(parse_skill_frontmatter(content).is_none());
    }

    #[test]
    fn test_discover_skills_empty_folder() {
        let temp = TempDir::new().unwrap();
        let skills = discover_skills(temp.path().to_str().unwrap());
        assert!(skills.is_empty());
    }

    #[test]
    fn test_discover_skills_with_skills() {
        let temp = TempDir::new().unwrap();
        let skills_dir = temp.path().join(".claude").join("skills").join("myskill");
        fs::create_dir_all(&skills_dir).unwrap();

        let skill_content = r#"---
name: myskill
description: My custom skill
user-invocable: true
---
# My Skill
"#;
        fs::write(skills_dir.join("SKILL.md"), skill_content).unwrap();

        let skills = discover_skills(temp.path().to_str().unwrap());
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "/myskill");
        assert_eq!(skills[0].description, "My custom skill");
    }

    #[test]
    fn test_discover_skills_excludes_non_invocable() {
        let temp = TempDir::new().unwrap();
        let skills_dir = temp.path().join(".claude").join("skills").join("internal");
        fs::create_dir_all(&skills_dir).unwrap();

        let skill_content = r#"---
name: internal
description: Internal skill
user-invocable: false
---
"#;
        fs::write(skills_dir.join("SKILL.md"), skill_content).unwrap();

        let skills = discover_skills(temp.path().to_str().unwrap());
        assert!(skills.is_empty());
    }

    #[test]
    fn test_list_commands_with_skills() {
        let temp = TempDir::new().unwrap();
        let skills_dir = temp.path().join(".claude").join("skills").join("custom");
        fs::create_dir_all(&skills_dir).unwrap();

        let skill_content = r#"---
name: custom
description: Custom skill
user-invocable: true
---
"#;
        fs::write(skills_dir.join("SKILL.md"), skill_content).unwrap();

        let commands = list_commands_with_skills(temp.path().to_str().unwrap());
        // 22 static + 1 discovered
        assert_eq!(commands.len(), 23);

        let names: Vec<&str> = commands.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"/custom"));
        assert!(names.contains(&"/compact")); // Static command still present
    }
}
